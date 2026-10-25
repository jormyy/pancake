import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'
import { nextWaiverRun } from './waiver-scenarios.mjs'

export async function beginTaxiAcquisitions(c, report, execute = sql) {
  if (c.taxiAcquisition) return
  const [adding, claiming] = c.users
  const player = await execute(`SELECT p.id FROM players p WHERE p.years_exp>0 AND p.career_regular_season_games<65
    AND p.nba_id IS NOT NULL AND p.position IS NOT NULL AND p.injury_status IS NULL
    AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM league_member_taxi_exits x WHERE x.league_id='${c.leagueId}' AND x.player_id=p.id
      AND x.member_id IN ('${adding.memberId}','${claiming.memberId}')) ORDER BY p.career_regular_season_games,p.id LIMIT 1`)
  assert.ok(player, 'Taxi acquisitions need a known eligible NBA veteran without a prior taxi exit')
  await c.rpc(adding, 'add_free_agent_atomic', { p_member_id: adding.memberId, p_league_id: c.leagueId, p_player_id: player, p_to_ir: false, p_to_taxi: true })
  const added = (await c.rest(adding, `roster_players?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${adding.memberId}&player_id=eq.${player}`))[0]
  assert.ok(added?.is_on_taxi && !added.is_on_ir, 'A full active roster can add straight to taxi')
  await c.rpc(adding, 'drop_player_atomic', { p_roster_player_id: added.id, p_expected_league_season_id: c.leagueSeasonId })
  const hold = (await c.rest(adding, `waiver_wire_log?select=*&league_season_id=eq.${c.leagueSeasonId}&player_id=eq.${player}&cleared_at=is.null`))[0]
  assert.ok(hold, 'The taxi drop creates a real waiver hold')
  await c.api(claiming, '/waivers/claims', { memberId: claiming.memberId, leagueId: c.leagueId, playerId: player, bidAmount: 0, toTaxi: true })
  const claim = (await c.rest(claiming, `waiver_claims?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${claiming.memberId}&player_id=eq.${player}&status=eq.pending`))[0]
  assert.ok(claim?.to_taxi, 'The claim keeps its requested taxi destination')
  const week = Number(await execute(`SELECT private.current_add_week_number('${c.leagueId}','${c.leagueSeasonId}')`))
  c.expectedAddsByWeek ??= {}
  const counts = c.expectedAddsByWeek[`${c.leagueSeasonId}:${week}`] ??= Object.fromEntries(c.users.map(user => [user.memberId, 0]))
  counts[adding.memberId]++
  c.taxiAcquisition = { player, claimId: claim.id, adding: adding.memberId, claiming: claiming.memberId, week, processAt: nextWaiverRun(Date.parse(hold.clears_at)) }
  report.taxiAcquisition = { ...c.taxiAcquisition, straightAdd: true, claimSubmitted: true, passed: false }
}

export async function verifyTaxiAcquisitions(c, report, execute = sql) {
  const scenario = c.taxiAcquisition
  if (!scenario) return
  report.taxiAcquisition ??= { ...scenario, straightAdd: true, claimSubmitted: true, passed: !!scenario.checked }
  if (scenario.checked || Number(await execute('SELECT extract(epoch FROM now())*1000')) < scenario.processAt) return
  const user = c.users.find(user => user.memberId === scenario.claiming)
  assert.ok(user)
  const claim = (await c.rest(user, `waiver_claims?select=*&id=eq.${scenario.claimId}`))[0]
  assert.equal(claim?.status, 'succeeded', 'The production waiver worker awards the taxi claim')
  assert.equal(Date.parse(claim.processed_at), scenario.processAt)
  const roster = (await c.rest(user, `roster_players?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}&player_id=eq.${scenario.player}`))[0]
  assert.ok(roster?.is_on_taxi && !roster.is_on_ir, 'The successful claim enters taxi without active roster space')
  await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: roster.id, p_expected_league_season_id: c.leagueSeasonId })
  const week = Number(await execute(`SELECT private.current_add_week_number('${c.leagueId}','${c.leagueSeasonId}')`))
  const counts = c.expectedAddsByWeek[`${c.leagueSeasonId}:${week}`] ??= Object.fromEntries(c.users.map(user => [user.memberId, 0]))
  counts[user.memberId]++
  if (c.expectedWaiverPriorities) c.expectedWaiverPriorities[user.memberId] = Math.max(...Object.values(c.expectedWaiverPriorities)) + 1
  scenario.checked = true
  report.taxiAcquisition = { ...report.taxiAcquisition, passed: true, checked: true }
}
