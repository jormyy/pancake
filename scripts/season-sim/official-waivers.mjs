import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'
import { nextWaiverRun } from './waiver-scenarios.mjs'
import { waiverOutcomes, checkWaiverResult, checkWaiverTiming } from './waiver-oracle.mjs'

const rosters = async c => sqlJson(`SELECT coalesce(json_agg(r ORDER BY member_id,player_id),'[]') FROM roster_players r WHERE league_season_id='${c.leagueSeasonId}' AND NOT is_on_ir AND NOT is_on_taxi`, 'Official FAAB rosters')
const states = async c => Object.fromEntries(await Promise.all(c.users.map(async user => [user.memberId, (await c.rpc(user, 'get_member_transaction_state', { p_member_id: user.memberId, p_league_id: c.leagueId }))[0]])))

export async function beginOfficialWaivers(c, now, report) {
  const roster = await rosters(c), before = await states(c)
  const priorities = await c.rest(c.users[0], `waiver_priorities?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  const free = await sqlJson(`SELECT coalesce(json_agg(p),'[]') FROM (SELECT id FROM players p WHERE status='Active' AND nba_id IS NOT NULL AND position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL) ORDER BY nba_id LIMIT 2) p`, 'Official unowned players')
  assert.equal(free.length, 2)
  const rejected = await c.rpc(c.users[0], 'add_free_agent_atomic', { p_member_id: c.users[0].memberId, p_league_id: c.leagueId, p_player_id: free[0].id }, 400)
  assert.match(JSON.stringify(rejected), /waiver|claim|FAAB/i)
  await c.api(c.users[0], '/waivers/claims', { memberId: c.users[0].memberId, leagueId: c.leagueId, playerId: free[0].id, bidAmount: 101 }, 400)
  const claims = []
  for (const user of c.users.slice(0, 2)) {
    const drop = roster.find(row => row.member_id === user.memberId)?.player_id
    assert.ok(drop)
    await c.api(user, '/waivers/claims', { memberId: user.memberId, leagueId: c.leagueId, playerId: free[0].id, dropPlayerId: drop, bidAmount: 19 })
    const [claim] = await c.rest(user, `waiver_claims?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}&player_id=eq.${free[0].id}&status=eq.pending`)
    assert.ok(claim)
    claims.push({ id: claim.id, member: user.memberId, player: claim.player_id, drop, bid: 19, order: claim.claim_order, submitted: claim.submitted_at })
  }
  const user = c.users[2]
  await c.api(user, '/waivers/claims', { memberId: user.memberId, leagueId: c.leagueId, playerId: free[1].id, dropPlayerId: roster.find(row => row.member_id === user.memberId).player_id, bidAmount: 0 })
  const [cancelled] = await c.rest(user, `waiver_claims?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}&player_id=eq.${free[1].id}&status=eq.pending`)
  await c.api(user, `/waivers/claims/${cancelled.id}/cancel`, { memberId: user.memberId })
  const input = { claims, mode: 'faab', priorities: Object.fromEntries(priorities.map(row => [row.member_id, row.priority])), budgets: Object.fromEntries(Object.entries(before).map(([id, row]) => [id, row.faab_balance])), rosterCounts: Object.fromEntries(c.users.map(user => [user.memberId, roster.filter(row => row.member_id === user.memberId).length])), weeklyCounts: Object.fromEntries(Object.entries(before).map(([id, row]) => [id, row.weekly_add_count])), limit: 2, rosterSize: 20 }
  const scenario = { input, expected: waiverOutcomes(input), processAt: nextWaiverRun(now + 1), cancelled: cancelled.id, checked: false }
  report.waivers = scenario
  return scenario
}

export async function verifyOfficialWaivers(c, scenario, now) {
  if (!scenario || scenario.checked || now < scenario.processAt) return
  const claims = await sqlJson(`SELECT coalesce(json_agg(w),'[]') FROM waiver_claims w WHERE id IN (${scenario.input.claims.map(row => `'${row.id}'`).join(',')})`, 'Official FAAB awards')
  const priorities = await c.rest(c.users[0], `waiver_priorities?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  const roster = await rosters(c)
  scenario.result = checkWaiverResult(scenario.expected, { claims, priorities, states: await states(c), rosterCounts: Object.fromEntries(c.users.map(user => [user.memberId, roster.filter(row => row.member_id === user.memberId).length])) })
  for (const claim of claims) checkWaiverTiming(claim.processed_at, scenario.processAt)
  for (const claim of scenario.input.claims) {
    const won = scenario.expected.claims[claim.id] === 'succeeded'
    assert.equal(roster.some(row => row.member_id === claim.member && row.player_id === claim.player), won)
    assert.equal(roster.some(row => row.member_id === claim.member && row.player_id === claim.drop), !won)
  }
  scenario.checked = true
}
