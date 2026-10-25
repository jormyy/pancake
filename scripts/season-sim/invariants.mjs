import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'

export async function assertTaxiTransactions(c, execute = sql) {
  const rows = JSON.parse(await execute(`SELECT coalesce(json_agg(t),'[]') FROM (
    SELECT r.member_id,p.display_name AS player_name,
      ARRAY(SELECT injured.display_name FROM roster_players ir JOIN players injured ON injured.id=ir.player_id
        WHERE ir.league_season_id=r.league_season_id AND ir.member_id=r.member_id AND ir.is_on_ir
          AND NOT private.is_ir_designation(injured.injury_status)) AS ir_names,
      (SELECT count(*) FROM roster_players active WHERE active.league_season_id=r.league_season_id
        AND active.member_id=r.member_id AND NOT active.is_on_ir AND NOT active.is_on_taxi)>
        (SELECT roster_size FROM leagues WHERE id=r.league_id) AS active_overflow,
      (SELECT f.id FROM players f WHERE NOT EXISTS(SELECT 1 FROM roster_players owned
        WHERE owned.league_id=r.league_id AND owned.player_id=f.id)
        AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id=r.league_id
          AND w.player_id=f.id AND w.cleared_at IS NULL) ORDER BY f.id LIMIT 1) AS candidate
    FROM roster_players r JOIN players p ON p.id=r.player_id
    WHERE r.league_id='${c.leagueId}' AND r.league_season_id='${c.leagueSeasonId}' AND r.is_on_taxi
      AND NOT coalesce(p.years_exp=0 OR p.career_regular_season_games<65,false)
    ORDER BY r.member_id,p.display_name
  ) t`))
  const members = [...new Set(rows.map(row => row.member_id))]
  for (const memberId of members) {
    const user = c.users.find(user => user.memberId === memberId)
    assert.ok(user, 'Every illegal taxi roster has an authenticated owner')
    const problems = rows.filter(row => row.member_id === memberId)
    assert.ok(problems[0].candidate, 'The refusal probe requires an available free agent')
    const refused = await c.rpc(user, 'add_free_agent_atomic', { p_member_id: memberId, p_league_id: c.leagueId, p_player_id: problems[0].candidate }, 400)
    if (refused.code === 'PA005' && problems[0].ir_names?.length) {
      for (const name of problems[0].ir_names) assert.ok(refused.message?.includes(name), `IR refusal names ${name}`)
      continue
    }
    if (refused.code === 'PA003' && problems[0].active_overflow) {
      assert.match(refused.message, /active|roster|limit/i)
      continue
    }
    assert.equal(refused.code, 'PA009', 'An ineligible taxi roster refuses acquisitions with PA009')
    for (const problem of problems) assert.ok(refused.message?.includes(problem.player_name), `Taxi refusal names ${problem.player_name}`)
  }
  return { eligible: rows.length === 0, blockedTeams: members.length }
}

export async function assertDomain(c, previous = {}) {
  const league = `'${c.leagueId}'`, season = `'${c.leagueSeasonId}'`
  const state = JSON.parse(await sql(`SELECT json_build_object(
    'duplicateRosters',(SELECT count(*) FROM (SELECT league_season_id,player_id FROM roster_players WHERE league_id=${league} GROUP BY 1,2 HAVING count(*)>1) d),
    'slotOverflow',(SELECT count(*) FROM (SELECT w.member_id,w.game_date,w.slot_type,count(*) FROM weekly_lineups w JOIN lineup_slot_templates t ON t.league_id=w.league_id AND t.slot_type=w.slot_type WHERE w.league_id=${league} AND w.slot_type NOT IN('BE','IR') GROUP BY 1,2,3,t.slot_count HAVING count(*)>t.slot_count) d),
    'rosterOverflow',(SELECT count(*) FROM (SELECT r.member_id,r.league_season_id FROM roster_players r JOIN leagues l ON l.id=r.league_id WHERE r.league_id=${league} GROUP BY 1,2,l.roster_size,l.ir_slots,l.taxi_slots HAVING count(*) FILTER(WHERE NOT r.is_on_ir AND NOT r.is_on_taxi)>l.roster_size OR count(*) FILTER(WHERE r.is_on_ir)>l.ir_slots OR count(*) FILTER(WHERE r.is_on_taxi)>l.taxi_slots) d),
    'negativeFaab',(SELECT count(*) FROM faab_balances WHERE league_id=${league} AND balance<0),
    'negativeAuction',(SELECT count(*) FROM draft_budgets b JOIN drafts d ON d.id=b.draft_id WHERE d.league_id=${league} AND b.remaining<0),
    'doubleInactive',(SELECT count(*) FROM roster_players WHERE league_id=${league} AND is_on_ir AND is_on_taxi),
    'duplicatePriority',(SELECT count(*) FROM (SELECT league_season_id,priority FROM waiver_priorities WHERE league_id=${league} GROUP BY 1,2 HAVING count(*)>1) d),
    'orphanPickOwner',(SELECT count(*) FROM draft_picks p WHERE p.league_id=${league} AND NOT EXISTS(SELECT 1 FROM league_members m WHERE m.league_id=p.league_id AND m.id=p.current_owner_id)),
    'playerStats',(SELECT count(*) FROM player_game_stats),
    'historySeasons',(SELECT count(*) FROM league_seasons WHERE league_id=${league}),
    'historyMatchups',(SELECT count(*) FROM matchups WHERE league_id=${league}),
    'standings',(SELECT coalesce(json_agg(s),'[]') FROM standings s WHERE league_season_id=${season}),
    'results',(SELECT coalesce(json_agg(m),'[]') FROM matchups m WHERE league_season_id=${season} AND matchup_type='regular_season' AND is_finalized AND NOT is_voided)
  )`))
  let checks = 0
  for (const key of ['duplicateRosters', 'slotOverflow', 'rosterOverflow', 'negativeFaab', 'negativeAuction', 'doubleInactive', 'duplicatePriority', 'orphanPickOwner']) { assert.equal(state[key], 0, key); checks++ }
  const taxi = await assertTaxiTransactions(c)
  checks++
  for (const key of ['playerStats', 'historySeasons', 'historyMatchups']) { assert.ok(state[key] >= (previous[key] ?? 0), `${key} must never decrease`); checks++ }
  if (state.results.length) assert.ok(state.standings.length > 0, 'Finalized regular results require standings rows')
  for (const standing of state.standings) {
    const results = state.results.filter(result => result.week_number <= standing.week_number && [result.home_member_id, result.away_member_id].includes(standing.member_id))
    const expected = { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 }
    for (const result of results) {
      assert.equal(result.winner_member_id, result.home_points === result.away_points ? null : result.home_points > result.away_points ? result.home_member_id : result.away_member_id, 'Regular season result agrees with points')
      expected[result.winner_member_id == null ? 'ties' : result.winner_member_id === standing.member_id ? 'wins' : 'losses']++
      const home = result.home_member_id === standing.member_id
      expected.points_for += home ? result.home_points : result.away_points
      expected.points_against += home ? result.away_points : result.home_points
    }
    for (const [key, value] of Object.entries(expected)) { assert.equal(Number(standing[key]), Math.round(value * 100) / 100, `Standings ${key}`); checks++ }
  }
  return { checks, taxi, playerStats: state.playerStats, historySeasons: state.historySeasons, historyMatchups: state.historyMatchups, standingsRows: state.standings.length, ties: state.results.filter(result => result.winner_member_id == null).length }
}

export function assertLiveCoverage(coverage, games, plan) {
  let checks = 0
  for (const game of games) {
    const observed = coverage.games[game.id]
    assert.ok(game.provenance === 'SYNTHETIC' ? observed?.finalSynthetic > 0 : observed?.finalRaw > 0, `${game.id}: official raw final must reach the pipeline`)
    assert.ok(observed.scoreboard > 0, `${game.id}: real-derived scoreboard must reach the pipeline`)
    const snapshots = Object.keys(game.provenance === 'SYNTHETIC' ? observed.syntheticLive ?? {} : observed.live)
    assert.ok(snapshots.length >= plan.minimumSnapshots, `${game.id}: needs ${plan.minimumSnapshots} live snapshots, saw ${snapshots.length}`)
    if (plan.requiredPeriods) for (const period of plan.requiredPeriods) assert.ok(snapshots.some(key => key.startsWith(`${period}:`)), `${game.id}: missing quarter ${period}`)
    checks += 3 + (plan.requiredPeriods?.length ?? 0)
  }
  return { checks, games: games.length, minimumSnapshots: plan.minimumSnapshots, snapshotCounts: Object.fromEntries(games.map(game => [game.id, Object.keys(game.provenance === 'SYNTHETIC' ? coverage.games[game.id].syntheticLive ?? {} : coverage.games[game.id].live).length])) }
}

export async function assertHistoricalTeams(expected, previous = {}) {
  const stored = JSON.parse(await sql('SELECT json_object_agg(espn_id,nba_team) FROM players WHERE espn_id IS NOT NULL'))
  const changes = []
  for (const player of expected) {
    assert.equal(stored[player.espnId], player.nbaTeam, `Historical NBA roster observation must reach the player master: ESPN ${player.espnId}`)
    if (previous[player.espnId] && previous[player.espnId] !== player.nbaTeam) changes.push({ espnId: player.espnId, from: previous[player.espnId], to: player.nbaTeam, provenance: 'REAL-DERIVED; first observed game date, announcement time unavailable' })
  }
  return { checked: expected.length, changes, teams: stored }
}
