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
  const [success, retry, terminal] = targetClaims
  assert.equal(await rpc(fixture.admin, 'complete_notification_outbox_atomic', {
    p_id: success.id, p_claim_token: success.claim_token,
  }), true)
  assert.equal(await rpc(fixture.admin, 'fail_notification_outbox_atomic', {
    p_id: retry.id, p_claim_token: retry.claim_token, p_error: 'Web push HTTP 503',
  }), true)
  assert.equal(await rpc(fixture.admin, 'dead_letter_notification_outbox_atomic', {
    p_id: terminal.id, p_claim_token: terminal.claim_token, p_error: 'Web push HTTP 400',
  }), true)
  const { data: retryState, error: retryStateError } = await fixture.admin
    .from('notification_outbox')
    .select('attempt_count, claimed_at, claim_token, last_error, available_at')
    .eq('id', retry.id).single()
  if (retryStateError) throw new Error(`retry outbox lookup: ${retryStateError.message}`)
  assert.equal(retryState.attempt_count, 1)
  assert.equal(retryState.claimed_at, null)
  assert.equal(retryState.claim_token, null)
  assert.equal(retryState.last_error, 'Web push HTTP 503')
  assert(Date.parse(retryState.available_at) > Date.now())
  const { error: retryDueError } = await fixture.admin.from('notification_outbox')
    .update({ available_at: new Date(Date.now() - 1_000).toISOString() }).eq('id', retry.id)
  if (retryDueError) throw new Error(`outbox retry scheduling fixture: ${retryDueError.message}`)
  const retried = (await rpc(fixture.admin, 'claim_notification_outbox_atomic', {
    p_limit: 200, p_lease_seconds: 60,
  })).find(entry => entry.id === retry.id)
  assert(retried, 'temporary web failure is not reclaimable')
  assert.notEqual(retried.claim_token, retry.claim_token)
  const { data: terminalRows, error: terminalRowsError } = await fixture.admin
    .from('notification_outbox')
    .select('id, delivered_at, dead_lettered_at')
    .in('id', [success.id, retry.id, terminal.id])
  if (terminalRowsError) throw new Error(`terminal web delivery state lookup: ${terminalRowsError.message}`)
  assert(terminalRows.find((entry) => entry.id === success.id)?.delivered_at)
  assert.equal(terminalRows.find((entry) => entry.id === retry.id)?.delivered_at, null)
  assert(terminalRows.find((entry) => entry.id === terminal.id)?.dead_lettered_at)
}
