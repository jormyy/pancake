import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { miniRoot, writeJson } from './common.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { publishedWeekNumber } from './calendar.mjs'

/** @returns {AsyncGenerator<{ day: number, date?: undefined } | { date: string, day?: undefined }, undefined>} */
export async function* actionPhases(c, report) {
  const [a, b, d, e] = c.users
  report.leagueId = c.leagueId
  const scope = `league_id='${c.leagueId}' AND league_season_id='${c.leagueSeasonId}'`
  const roster = async user => JSON.parse(await sql(`SELECT json_agg(r ORDER BY player_id) FROM roster_players r WHERE ${scope} AND member_id='${user.memberId}'`))
  const owner = player => sql(`SELECT member_id FROM roster_players WHERE ${scope} AND player_id='${player}'`)
  const settings = values => c.rpc(a, 'update_league_settings_atomic', { p_league_id: c.leagueId, p_settings: values })
  const record = async name => { report.completed.push(name); await writeJson(path.join(miniRoot, 'evidence/integrated-actions.json'), report); console.log(name) }
  await record('four authenticated users; league creation/join/settings; 12-player auction; budget rejection; daily Auto-set')
  await settings({ allow_inactive_trades: true, weekly_add_limit: 8, waiver_mode: 'rolling', trade_veto_mode: 'commissioner', trade_veto_window_hours: 24 })
  const original = await roster(a)
  for (const row of original.slice(0, 2)) await c.rpc(a, 'drop_player_atomic', { p_roster_player_id: row.id })
  const free = JSON.parse(await sql(`SELECT json_agg(p) FROM (SELECT id,injury_status FROM players WHERE position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=players.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=players.id AND cleared_at IS NULL) ORDER BY (injury_status IS NOT NULL) DESC,nba_id LIMIT 60) p`))
  const injured = free.find(player => ['Out', 'O', 'IR', 'Injured'].includes(player.injury_status))
  assert.ok(injured, 'The historical injury feed must supply an IR-eligible player')
  await c.rpc(a, 'add_free_agent_atomic', { p_member_id: a.memberId, p_league_id: c.leagueId, p_player_id: injured.id })
  const ir = (await roster(a)).find(row => row.player_id === injured.id)
  await c.api(a, '/league/roster/ir', { rosterPlayerId: ir.id, isOnIR: true })
  assert.equal(await sql(`SELECT is_on_ir FROM roster_players WHERE id='${ir.id}'`), 't')
  for (const player of free.filter(player => player.injury_status == null).slice(0, 2)) await c.rpc(a, 'add_free_agent_atomic', { p_member_id: a.memberId, p_league_id: c.leagueId, p_player_id: player.id })
  assert.equal((await roster(a)).filter(row => !row.is_on_ir).length, 3)
  await c.api(a, '/league/roster/ir', { rosterPlayerId: ir.id, isOnIR: false }, 400)
  await settings({ weekly_add_limit: 3 })
  const spare = (await roster(a)).find(row => !row.is_on_ir)
  await c.rpc(a, 'drop_player_atomic', { p_roster_player_id: spare.id })
  const extra = free.filter(player => player.injury_status == null)[2]
  await c.rpc(a, 'add_free_agent_atomic', { p_member_id: a.memberId, p_league_id: c.leagueId, p_player_id: extra.id }, 400)
  await settings({ weekly_add_limit: 8 })
  await c.rpc(a, 'add_free_agent_atomic', { p_member_id: a.memberId, p_league_id: c.leagueId, p_player_id: extra.id })
  await record('real injury feed → IR; full-roster IR return refused; weekly add limit refused; free-agent add/drop')
  const bRoster = await roster(b), dRoster = await roster(d)
  const claim = (user, player, drop, bid = 0) => c.api(user, '/waivers/claims', { leagueId: c.leagueId, memberId: user.memberId, playerId: player, dropPlayerId: drop, bidAmount: bid })
  await claim(b, original[0].player_id, bRoster[0].player_id)
  await c.api(b, '/waivers/claims', { leagueId: c.leagueId, memberId: b.memberId, playerId: original[0].player_id, dropPlayerId: bRoster[0].player_id }, 400)
  await claim(d, original[0].player_id, dRoster[0].player_id)
  await claim(b, original[1].player_id, bRoster[1].player_id)
  const claims = JSON.parse(await sql(`SELECT json_agg(w ORDER BY claim_order) FROM waiver_claims w WHERE ${scope} AND member_id='${b.memberId}' AND status='pending'`))
  await c.api(b, `/waivers/claims/${claims[0].id}/edit`, { memberId: b.memberId, dropPlayerId: bRoster[0].player_id, bidAmount: 0, claimOrder: 1 })
  await c.api(b, `/waivers/claims/${claims[0].id}/reorder`, { memberId: b.memberId, direction: 'down' })
  await c.api(b, `/waivers/claims/${claims[1].id}/cancel`, { memberId: b.memberId })
  const winner = await sql(`SELECT member_id FROM waiver_claims WHERE ${scope} AND player_id='${original[0].player_id}' AND status='pending' ORDER BY priority_at_submission LIMIT 1`)
  yield { day: 1 }
  await dispatch("SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)")
  assert.equal(await owner(original[0].player_id), '', '48-hour waiver clearance must hold')
  yield { day: 2 }
  await dispatch("SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)")
  assert.equal(await owner(original[0].player_id), winner)
  await record('rolling waiver priority; duplicate refusal; edit/reorder/cancel; 48-hour clearance')
  const winningUser = c.users.find(user => user.memberId === winner)
  const won = (await roster(winningUser)).find(row => row.player_id === original[0].player_id)
  await c.rpc(winningUser, 'drop_player_atomic', { p_roster_player_id: won.id })
  await settings({ waiver_mode: 'faab' })
  const faabBefore = Number(await sql(`SELECT balance FROM faab_balances WHERE member_id='${e.memberId}' AND league_season_id='${c.leagueSeasonId}'`))
  await claim(e, won.player_id, (await roster(e))[0].player_id, 9)
  await claim(a, won.player_id, (await roster(a)).find(row => !row.is_on_ir).player_id, 5)
  const hidden = await c.rest(a, `waiver_claims?select=id,bid_amount&league_id=eq.${c.leagueId}&member_id=eq.${e.memberId}&status=eq.pending`)
  assert.deepEqual(hidden, [], 'Pending FAAB bids must remain private')
  yield { day: 4 }
  await dispatch("SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)")
  assert.equal(await owner(won.player_id), e.memberId)
  assert.equal(Number(await sql(`SELECT balance FROM faab_balances WHERE member_id='${e.memberId}' AND league_season_id='${c.leagueSeasonId}'`)), faabBefore - 9)
  await record('FAAB blind bids; highest bid wins; exact debit')
  const pick = await sql(`SELECT id FROM draft_picks WHERE league_id='${c.leagueId}' AND current_owner_id='${b.memberId}' ORDER BY season_year,round LIMIT 1`)
  assert.ok(pick)
  const offer = { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: a.memberId, recipientMemberId: b.memberId, offerPlayerIds: [ir.player_id], requestPickIds: [pick], requestFaabAmount: 3 }
  await settings({ allow_inactive_trades: false })
  await c.api(a, '/trades/propose', offer, 400)
  await settings({ allow_inactive_trades: true })
  const trade = await c.api(a, '/trades/propose', offer)
  assert.equal((await c.api(a, '/trades/propose', offer)).tradeId, trade.tradeId, 'Trade submission must be idempotent')
  const accept = () => c.api(b, `/trades/${trade.tradeId}/accept`, { memberId: b.memberId, rosterPlan: { irPlayerIds: [ir.player_id] } }, [200, 400, 409])
  await Promise.all([accept(), accept()])
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${trade.tradeId}'`), 'accepted')
  assert.equal(await owner(ir.player_id), a.memberId, 'Veto window must delay settlement')
  const participants = [b, d, e]
  const assets = await Promise.all(participants.map(async user => (await roster(user)).find(row => !row.is_on_ir)))
  const multi = await c.api(b, '/trades/propose-multi', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: b.memberId, participantMemberIds: [d.memberId, e.memberId], items: assets.map((row, index) => ({ fromMemberId: participants[index].memberId, toMemberId: participants[(index + 1) % 3].memberId, playerId: row.player_id })) })
  for (const user of participants.slice(1)) await c.api(user, `/trades/${multi.tradeId}/accept`, { memberId: user.memberId })
  yield { day: 5 }
  await dispatch('SELECT public.invoke_process_trades_if_due()')
  assert.equal(await owner(ir.player_id), b.memberId)
  assert.equal(await sql(`SELECT is_on_ir FROM roster_players WHERE ${scope} AND player_id='${ir.player_id}'`), 't')
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick}'`), a.memberId)
  for (const [index, row] of assets.entries()) assert.equal(await owner(row.player_id), participants[(index + 1) % 3].memberId)
  for (const id of [trade.tradeId, multi.tradeId]) assert.equal(await sql(`SELECT status FROM trades WHERE id='${id}'`), 'completed')
  await record('IR trade with roster plan; future pick and FAAB; concurrent accepts; idempotent offer; three-team trade; veto-window settlement')
  assert.equal(await sql(`SELECT count(*) FROM (SELECT player_id FROM roster_players WHERE ${scope} GROUP BY player_id HAVING count(*)>1) d`), '0')
  assert.equal(await sql(`SELECT count(*) FROM faab_balances WHERE league_id='${c.leagueId}' AND balance<0`), '0')

  yield { day: 6 }
  const offerFaab = async (from, to, amount = 1, extra = {}) => c.api(from, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: from.memberId, recipientMemberId: to.memberId, offerFaabAmount: amount, requestFaabAmount: 2, ...extra })
  const rejected = await offerFaab(a, b)
  await c.api(b, `/trades/${rejected.tradeId}/reject`, { memberId: b.memberId })
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${rejected.tradeId}'`), 'rejected')
  const initial = await offerFaab(a, b)
  const counter = await c.api(b, `/trades/${initial.tradeId}/counter`, { requestId: randomUUID(), memberId: b.memberId, offerFaabAmount: 2, requestFaabAmount: 1 })
  await c.api(a, `/trades/${counter.tradeId}/reject`, { memberId: a.memberId })
  const vetoed = await offerFaab(b, d)
  await c.api(d, `/trades/${vetoed.tradeId}/accept`, { memberId: d.memberId })
  await c.api(a, `/trades/${vetoed.tradeId}/veto`, { memberId: a.memberId })
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${vetoed.tradeId}'`), 'vetoed')
  const now = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  const expiring = await offerFaab(a, b, 1, { expiresAt: new Date(now + 3600000).toISOString() })
  await record('trade rejection, counteroffer, commissioner veto; expiring offer submitted')
  await dispatch(`SELECT public.invoke_edge_function('sync-draft-order','{"seasonYear":2025}')`)
  const synthetic = await sql("SELECT id FROM players WHERE display_name='Synthetic Prospect 2025 1'")
  assert.ok(synthetic, 'Synthetic eligibility metadata must enter through the real draft-board ingestion')
  const spareRow = (await roster(d)).find(row => !row.is_on_ir && !row.is_on_taxi)
  await c.rpc(d, 'drop_player_atomic', { p_roster_player_id: spareRow.id })
  await c.rpc(d, 'add_free_agent_atomic', { p_member_id: d.memberId, p_league_id: c.leagueId, p_player_id: synthetic })
  const taxiTrade = await c.api(d, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: d.memberId, recipientMemberId: e.memberId, offerPlayerIds: [synthetic], requestFaabAmount: 1 })
  await c.api(e, `/trades/${taxiTrade.tradeId}/accept`, { memberId: e.memberId, rosterPlan: { taxiPlayerIds: [synthetic] } })
  for (const row of (await roster(d)).filter(row => row.player_id !== synthetic)) await c.rpc(d, 'drop_player_atomic', { p_roster_player_id: row.id })
  for (const number of [2, 3]) {
    const playerId = await sql(`SELECT id FROM players WHERE display_name='Synthetic Prospect 2025 ${number}'`)
    await c.rpc(d, 'add_free_agent_atomic', { p_member_id: d.memberId, p_league_id: c.leagueId, p_player_id: playerId })
  }
  await record('synthetic prospect roster starts a full fantasy week with zero NBA games')
  yield { day: 7 }
  await dispatch('SELECT public.invoke_process_trades_if_due()')
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${expiring.tradeId}'`), 'expired')
  assert.equal(await owner(synthetic), e.memberId)
  assert.equal(await sql(`SELECT is_on_taxi FROM roster_players WHERE ${scope} AND player_id='${synthetic}'`), 't')
  const taxiAgain = await c.api(e, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: e.memberId, recipientMemberId: b.memberId, offerPlayerIds: [synthetic], requestFaabAmount: 1 })
  await c.api(b, `/trades/${taxiAgain.tradeId}/accept`, { memberId: b.memberId, rosterPlan: { taxiPlayerIds: [synthetic] } })
  await record('offer expiry; synthetic rookie enters taxi through a real trade with a roster plan')
  yield { day: 8 }
  await dispatch('SELECT public.invoke_process_trades_if_due()')
  assert.equal(await owner(synthetic), b.memberId)
  assert.equal(await sql(`SELECT is_on_taxi FROM roster_players WHERE ${scope} AND player_id='${synthetic}'`), 't')
  while ((await roster(b)).filter(row => !row.is_on_ir && !row.is_on_taxi).length < 3) {
    const available = await sql(`SELECT p.id FROM players p WHERE p.nba_id IS NOT NULL AND p.position IS NOT NULL AND p.injury_status IS NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL) ORDER BY nba_id LIMIT 1`)
    await c.rpc(b, 'add_free_agent_atomic', { p_member_id: b.memberId, p_league_id: c.leagueId, p_player_id: available })
  }
  const taxiRow = (await roster(b)).find(row => row.player_id === synthetic)
  await c.api(b, '/league/roster/taxi', { rosterPlayerId: taxiRow.id, isOnTaxi: false }, 400)
  await record('taxi-to-taxi trade continuity; full-roster taxi activation refused')
  yield { day: 13 }
  const noGameRoster = await roster(d)
  assert.equal(await sql(`SELECT count(*) FROM roster_players r JOIN players p ON p.id=r.player_id JOIN nba_games g ON p.nba_team IN(g.home_team,g.away_team) WHERE r.league_season_id='${c.leagueSeasonId}' AND r.member_id='${d.memberId}' AND g.game_date BETWEEN '2025-10-27' AND '2025-11-02'`), '0')
  for (const row of noGameRoster) await c.rpc(d, 'drop_player_atomic', { p_roster_player_id: row.id })
  for (let index = 0; index < 3; index++) {
    const available = await sql(`SELECT p.id FROM players p WHERE p.nba_id IS NOT NULL AND p.position IS NOT NULL AND p.injury_status IS NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL) ORDER BY nba_id LIMIT 1`)
    await c.rpc(d, 'add_free_agent_atomic', { p_member_id: d.memberId, p_league_id: c.leagueId, p_player_id: available })
  }
  await record('zero-game fantasy week preserved without invented NBA games or scores; real-player roster restored')
  yield { date: '2026-02-09' }
  const skipped = publishedWeekNumber(await sql("SELECT week_number FROM season_weeks WHERE season_year=2026 AND '2026-02-09' BETWEEN week_start AND week_end"))
  assert.ok(skipped, 'The pre-All-Star week must exist in the real calendar')
  await settings({ skipped_weeks: [skipped] })
  assert.equal(await sql(`SELECT count(*) FROM matchups WHERE league_season_id='${c.leagueSeasonId}' AND week_number=${skipped} AND NOT is_voided`), '0')
  await record('commissioner skips the short pre-All-Star week; the published All-Star calendar gap stays empty')
  report.passed = true
}
