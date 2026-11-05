import assert from 'node:assert/strict'
import {
  executeRecoverySql,
  faabRoutes,
  fetchTrade,
  rpc,
  setBalances,
  setLeagueRules,
} from './multi-team-trade-db-support.mjs'

export const assertCompletionFailureKeepsRepairableTrade = async (fixture) => {
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
  assert.equal(result.status, 'deferred')
  const held = await fetchTrade(fixture, tradeId)
  assert.equal(held.status, 'accepted')
  assert.match(held.completion_failure_reason, /short by 20 FAAB/i)
  assert.equal(await fixture.admin.from('notification_outbox').select('id', { count: 'exact', head: true })
    .like('dedupe_key', `trade_terminal_failure:${tradeId}:%`).then(result => result.count), 0)
  await setBalances(fixture, [[fixture.proposer.id, 100]])
  const retried = await rpc(fixture.admin, 'process_due_accepted_trades_atomic', { p_limit: 200 })
  assert.equal(retried.find(row => row.trade_id === tradeId)?.status, 'completed')
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'completed')
}
