import assert from 'node:assert/strict'
import {
  executeRecoverySql,
  faabRoutes,
  fetchTrade,
  rpc,
  setBalances,
  setLeagueRules,
} from './multi-team-trade-db-support.mjs'

export const assertCompletionFailureIsTerminal = async (fixture) => {
  await setLeagueRules(fixture, {
    status: 'offseason',
    waiver_mode: 'faab',
    trade_veto_mode: 'commissioner',
    trade_veto_window_hours: 1,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 60],
    [fixture.recipient.id, 0],
    [fixture.observer.id, 0],
  ])
  const past = new Date(Date.now() - 60_000).toISOString()
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'accepted',
      accepted_at: past,
      veto_window_expires_at: past,
      is_multi_team: true,
      notes: 'DB offseason terminal completion failure',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`offseason accepted trade insert: ${tradeError.message}`)
  const tradeId = trade.id
  executeRecoverySql(`
    INSERT INTO public.trade_participants
      (trade_id, member_id, sort_order, is_initiator, accepted_at)
    VALUES
      ('${tradeId}', '${fixture.proposer.id}', 0, true, '${past}'),
      ('${tradeId}', '${fixture.recipient.id}', 1, false, '${past}'),
      ('${tradeId}', '${fixture.observer.id}', 2, false, '${past}');
  `)
  const { error: itemError } = await fixture.admin.from('trade_items').insert(
    faabRoutes(fixture).map((item) => ({
      trade_id: tradeId,
      side: 'proposer',
      from_member_id: item.fromMemberId,
      to_member_id: item.toMemberId,
      faab_amount: item.faabAmount,
    })),
  )
  if (itemError) throw new Error(`offseason trade item insert: ${itemError.message}`)

  const processed = await rpc(fixture.admin, 'process_due_accepted_trades_atomic', { p_limit: 50 })
  const result = processed.find((row) => row.trade_id === tradeId)
  assert(result, 'due-trade processor did not return the target trade')
  assert.equal(result.status, 'expired_terminal_failure')
  assert.equal(result.error_code, 'PT001')
  assert.match(result.error_message, /enough FAAB/i)
  assert.deepEqual(new Set(result.participant_member_ids), new Set([
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ]))

  const completedTrade = await fetchTrade(fixture, tradeId)
  assert.equal(completedTrade.status, 'expired')
  assert.match(completedTrade.completion_failure_reason, /enough FAAB/i)

  const { data: activity, error: activityError } = await fixture.admin
    .from('league_activity')
    .select('event_type, body, related_trade_id')
    .eq('related_trade_id', tradeId)
    .eq('event_type', 'trade_completion_failed')
  if (activityError) throw new Error(`terminal trade activity lookup: ${activityError.message}`)
  assert.equal(activity.length, 1)
  assert.match(activity[0].body, /enough FAAB/i)

  const { data: queued, error: queuedError } = await fixture.admin
    .from('notification_outbox')
    .select('id, member_id, dedupe_key, delivered_at')
    .like('dedupe_key', `trade_terminal_failure:${tradeId}:%`)
  if (queuedError) throw new Error(`terminal trade outbox lookup: ${queuedError.message}`)
  assert.deepEqual(new Set(queued.map((entry) => entry.member_id)), new Set([
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ]))
  assert.equal(new Set(queued.map((entry) => entry.dedupe_key)).size, 3)

  const claimed = await rpc(fixture.admin, 'claim_notification_outbox_atomic', {
    p_limit: 200,
    p_lease_seconds: 60,
  })
  const targetClaims = claimed.filter((entry) => queued.some((queuedEntry) => queuedEntry.id === entry.id))
  assert.equal(targetClaims.length, 3)
  const [success, retry, deferred] = targetClaims
  for (const [index, entry] of targetClaims.entries()) {
    assert.equal(await rpc(fixture.admin, 'record_notification_outbox_ticket_atomic', {
      p_id: entry.id,
      p_claim_token: entry.claim_token,
      p_expo_ticket_id: `receipt-lifecycle-${tradeId}-${index}`,
      p_push_token: `ExponentPushToken[receipt-lifecycle-${index}]`,
      p_receipt_delay_seconds: 0,
    }), true)
  }

  const deliveryClaims = await rpc(fixture.admin, 'claim_notification_outbox_atomic', {
    p_limit: 200,
    p_lease_seconds: 60,
  })
  assert.equal(deliveryClaims.some((entry) => targetClaims.some((target) => target.id === entry.id)), false)

  const receiptClaims = await rpc(fixture.admin, 'claim_notification_receipts_atomic', {
    p_limit: 200,
    p_lease_seconds: 60,
  })
  const targetReceipts = receiptClaims.filter((entry) => targetClaims.some((target) => target.id === entry.id))
  assert.equal(targetReceipts.length, 3)
  const successReceipt = targetReceipts.find((entry) => entry.id === success.id)
  const retryReceipt = targetReceipts.find((entry) => entry.id === retry.id)
  const deferredReceipt = targetReceipts.find((entry) => entry.id === deferred.id)
  assert(successReceipt && retryReceipt && deferredReceipt)
  assert.equal(successReceipt.push_token, 'ExponentPushToken[receipt-lifecycle-0]')
  assert.equal(await rpc(fixture.admin, 'complete_notification_outbox_atomic', {
    p_id: successReceipt.id,
    p_claim_token: successReceipt.claim_token,
  }), true)
  assert.equal(await rpc(fixture.admin, 'fail_notification_outbox_atomic', {
    p_id: retryReceipt.id,
    p_claim_token: retryReceipt.claim_token,
    p_error: 'Expo receipt: InvalidCredentials',
  }), true)
  assert.equal(await rpc(fixture.admin, 'defer_notification_receipt_atomic', {
    p_id: deferredReceipt.id,
    p_claim_token: deferredReceipt.claim_token,
    p_error: 'Expo receipt not ready',
    p_retry_delay_seconds: 15,
  }), true)

  const { data: retryState, error: retryStateError } = await fixture.admin
    .from('notification_outbox')
    .select('attempt_count, expo_ticket_id, push_token, ticketed_at, claimed_at, claim_token, last_error')
    .eq('id', retry.id)
    .single()
  if (retryStateError) throw new Error(`retry outbox lookup: ${retryStateError.message}`)
  assert.equal(retryState.attempt_count, 1)
  assert.equal(retryState.expo_ticket_id, null)
  assert.equal(retryState.push_token, null)
  assert.equal(retryState.ticketed_at, null)
  assert.equal(retryState.claimed_at, null)
  assert.equal(retryState.claim_token, null)
  assert.equal(retryState.last_error, 'Expo receipt: InvalidCredentials')

  const { data: deferredState, error: deferredStateError } = await fixture.admin
    .from('notification_outbox')
    .select('receipt_attempt_count, expo_ticket_id, push_token, claimed_at, claim_token, last_error')
    .eq('id', deferred.id)
    .single()
  if (deferredStateError) throw new Error(`deferred receipt lookup: ${deferredStateError.message}`)
  assert.equal(deferredState.receipt_attempt_count, 1)
  assert.equal(deferredState.expo_ticket_id, deferredReceipt.expo_ticket_id)
  assert.equal(deferredState.push_token, deferredReceipt.push_token)
  assert.equal(deferredState.claimed_at, null)
  assert.equal(deferredState.claim_token, null)
  assert.equal(deferredState.last_error, 'Expo receipt not ready')

  const { error: retryDueError } = await fixture.admin
    .from('notification_outbox')
    .update({ available_at: new Date(Date.now() - 1_000).toISOString() })
    .in('id', [retry.id, deferred.id])
  if (retryDueError) throw new Error(`outbox retry scheduling fixture: ${retryDueError.message}`)
  const retried = (await rpc(fixture.admin, 'claim_notification_outbox_atomic', {
    p_limit: 200,
    p_lease_seconds: 60,
  })).find((entry) => entry.id === retry.id)
  assert(retried, 'failed receipt was not reclaimable for a fresh delivery')
  assert.notEqual(retried.claim_token, retryReceipt.claim_token)
  const deferredAgain = (await rpc(fixture.admin, 'claim_notification_receipts_atomic', {
    p_limit: 200,
    p_lease_seconds: 60,
  })).find((entry) => entry.id === deferred.id)
  assert(deferredAgain, 'deferred receipt was not reclaimable without resending')
  assert.notEqual(deferredAgain.claim_token, deferredReceipt.claim_token)
  assert.equal(await rpc(fixture.admin, 'dead_letter_notification_outbox_atomic', {
    p_id: deferredAgain.id,
    p_claim_token: deferredAgain.claim_token,
    p_error: 'Expo receipt: MismatchSenderId',
  }), true)

  const { data: terminalRows, error: terminalRowsError } = await fixture.admin
    .from('notification_outbox')
    .select('id, delivered_at, dead_lettered_at')
    .in('id', [success.id, retry.id, deferred.id])
  if (terminalRowsError) throw new Error(`terminal receipt state lookup: ${terminalRowsError.message}`)
  assert(terminalRows.find((entry) => entry.id === success.id)?.delivered_at)
  assert.equal(terminalRows.find((entry) => entry.id === retry.id)?.delivered_at, null)
  assert(terminalRows.find((entry) => entry.id === deferred.id)?.dead_lettered_at)
}
