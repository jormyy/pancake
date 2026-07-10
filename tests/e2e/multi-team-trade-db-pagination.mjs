import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import {
  env,
  executeRecoverySql,
  queryRecoveryJson,
} from './multi-team-trade-db-support.mjs'

export const assertVetoRowsSurviveMemberHistoryPagination = async (fixture) => {
  const personalRows = Array.from({ length: 2_000 }, (_, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.observer.id,
    recipient_member_id: fixture.recipient.id,
    status: 'completed',
    proposed_at: new Date(Date.now() + index * 1000).toISOString(),
    completed_at: new Date().toISOString(),
    notes: `pagination history ${index}`,
  }))
  const { data: personalTrades, error: historyError } = await fixture.admin.from('trades').insert(personalRows).select('id')
  if (historyError) throw new Error(`pagination history insert: ${historyError.message}`)
  const { error: historyParticipantError } = await fixture.admin.from('trade_participants').insert(
    personalTrades.flatMap((trade) => [
      { trade_id: trade.id, member_id: fixture.observer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
      { trade_id: trade.id, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: new Date().toISOString() },
    ]),
  )
  if (historyParticipantError) throw new Error(`pagination participant insert: ${historyParticipantError.message}`)

  const { data: vetoTrade, error: vetoTradeError } = await fixture.admin.from('trades').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.proposer.id,
    recipient_member_id: fixture.recipient.id,
    status: 'accepted',
    proposed_at: '2000-01-01T00:00:00.000Z',
    accepted_at: new Date().toISOString(),
    veto_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    notes: 'observer veto row must bypass member history pagination',
  }).select('id').single()
  if (vetoTradeError) throw new Error(`observer veto trade insert: ${vetoTradeError.message}`)
  const { error: vetoParticipantError } = await fixture.admin.from('trade_participants').insert([
    { trade_id: vetoTrade.id, member_id: fixture.proposer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
    { trade_id: vetoTrade.id, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: new Date().toISOString() },
  ])
  if (vetoParticipantError) throw new Error(`observer veto participant insert: ${vetoParticipantError.message}`)

  const observerUser = fixture.users[2]
  const observerClient = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await observerClient.auth.signInWithPassword({
    email: observerUser.email,
    password: observerUser.password,
  })
  if (signInError) throw new Error(`observer sign in: ${signInError.message}`)
  const fetchPage = async (cursor = null) => {
    const { data: refs, error: refsError } = await observerClient.rpc('get_trade_page_refs', {
      p_member_id: fixture.observer.id,
      p_league_id: fixture.league.id,
      p_limit: 40,
      p_cursor: cursor,
    })
    if (refsError) throw new Error(`get_trade_page_refs pagination: ${refsError.message}`)
    const { data: trades, error: tradesError } = await observerClient.from('trades')
      .select('id, notes').in('id', refs.map((ref) => ref.trade_id))
    if (tradesError) throw new Error(`trade page rows: ${tradesError.message}`)
    const byId = new Map(trades.map((trade) => [trade.id, trade]))
    return { refs, rows: refs.map((ref) => byId.get(ref.trade_id)).filter(Boolean) }
  }
  const firstPage = await fetchPage()
  const rows = firstPage.rows
  assert.equal(rows.length, 40)
  assert(rows.some((trade) => trade.id === vetoTrade.id), 'vetoable observer trade was displaced by personal history')
  const nextCursor = firstPage.refs.at(-1)?.cursor_token
  assert(nextCursor, 'first trade page did not return a next cursor')
  const nextPage = await fetchPage(nextCursor)
  const nextRows = nextPage.rows
  assert.equal(nextRows.length, 40)
  assert.equal(nextRows.some((trade) => rows.some((firstPage) => firstPage.id === trade.id)), false)
  assert([...rows, ...nextRows].some((trade) => trade.notes?.startsWith('pagination history ')))

  executeRecoverySql('ANALYZE public.trades; ANALYZE public.trade_participants;')
  const explain = queryRecoveryJson(`
    SELECT set_config('request.jwt.claim.sub', '${observerUser.id}', false);
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM public.get_trade_page_refs('${fixture.observer.id}', '${fixture.league.id}', 40, NULL);
  `)
  const plan = explain[0].Plan
  assert.equal(plan['Actual Rows'], 40)
  assert(plan['Shared Hit Blocks'] < 2_500, `trade page read ${plan['Shared Hit Blocks']} shared blocks`)
  assert(plan['Actual Total Time'] < 100, `trade page took ${plan['Actual Total Time']} ms`)
  const { error: terminalError } = await fixture.admin
    .from('trades')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
    .eq('id', vetoTrade.id)
  if (terminalError) throw new Error(`observer veto trade cleanup: ${terminalError.message}`)
}
