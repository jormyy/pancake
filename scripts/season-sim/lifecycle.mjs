import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createLeagueActions } from './actions.mjs'
import { miniRoot, season, writeJson } from './common.mjs'
import { shiftDay } from './season-model.mjs'
import { setClock } from './clock.mjs'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { startRuntime } from './runtime.mjs'

export async function lifecycle(date = shiftDay(season.start,7)) {
  const report = { provenance: 'SYNTHETIC', date, completed: [], passed: false }
  const runtime = await startRuntime(`${date}T14:00:00Z`)
  try {
    await dispatch('SELECT public.dispatch_work()', { optional: true })
    await setClock({ at: `${date}T14:05:00Z`, rate: 0 })
    await dispatch('SELECT public.dispatch_work()', { optional: true })
    const c = await createLeagueActions(runtime.keys, date, 4)
    const [a, b, d, e] = c.users
    report.leagueId = c.leagueId
    const scope = `league_id='${c.leagueId}' AND league_season_id='${c.leagueSeasonId}'`
    const roster = async user => JSON.parse(await sql(`SELECT json_agg(r ORDER BY player_id) FROM roster_players r WHERE ${scope} AND member_id='${user.memberId}'`))
    const owner = player => sql(`SELECT member_id FROM roster_players WHERE ${scope} AND player_id='${player}'`)
    const settings = values => c.rpc(a, 'update_league_settings_atomic', { p_league_id: c.leagueId, p_settings: values })
    const atDay = async day => setClock({ at: new Date(Date.parse(`${date}T15:00:00Z`) + day * 86400000).toISOString(), rate: 0 })
    const record = async name => { report.completed.push(name); await writeJson(path.join(miniRoot, 'evidence/lifecycle.json'), report); console.log(name) }
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
    await record('real injury feed → free-agent add → IR move; free-agent add/drop')
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
    await atDay(1)
    await dispatch('SELECT public.dispatch_work()')
    assert.equal(await owner(original[0].player_id), '', '48-hour waiver clearance must hold')
    await atDay(2)
    await dispatch('SELECT public.dispatch_work()')
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
    await atDay(4)
    await dispatch('SELECT public.dispatch_work()')
    assert.equal(await owner(won.player_id), e.memberId)
    assert.equal(Number(await sql(`SELECT balance FROM faab_balances WHERE member_id='${e.memberId}' AND league_season_id='${c.leagueSeasonId}'`)), faabBefore - 9)
    await record('FAAB blind bids; highest bid wins; exact debit')
    const pick = await sql(`SELECT id FROM draft_picks WHERE league_id='${c.leagueId}' AND current_owner_id='${b.memberId}' ORDER BY season_year,round LIMIT 1`)
    assert.ok(pick)
    const offer = { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: a.memberId, recipientMemberId: b.memberId, offerPlayerIds: [ir.player_id], requestPickIds: [pick], requestFaabAmount: 3 }
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
    await atDay(5)
    await dispatch('SELECT public.dispatch_work()')
    assert.equal(await owner(ir.player_id), b.memberId)
    assert.equal(await sql(`SELECT is_on_ir FROM roster_players WHERE ${scope} AND player_id='${ir.player_id}'`), 't')
    assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${pick}'`), a.memberId)
    for (const [index, row] of assets.entries()) assert.equal(await owner(row.player_id), participants[(index + 1) % 3].memberId)
    for (const id of [trade.tradeId, multi.tradeId]) assert.equal(await sql(`SELECT status FROM trades WHERE id='${id}'`), 'completed')
    await record('IR trade with roster plan; future pick and FAAB; concurrent accepts; idempotent offer; three-team trade; veto-window settlement')
    assert.equal(await sql(`SELECT count(*) FROM (SELECT player_id FROM roster_players WHERE ${scope} GROUP BY player_id HAVING count(*)>1) d`), '0')
    assert.equal(await sql(`SELECT count(*) FROM faab_balances WHERE league_id='${c.leagueId}' AND balance<0`), '0')
    report.passed = true
    await record('roster uniqueness and nonnegative FAAB')
  } finally {
    await writeJson(path.join(miniRoot, 'evidence/lifecycle.json'), report)
    await runtime.close()
  }
}
