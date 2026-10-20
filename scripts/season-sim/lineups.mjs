import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'
import { publishedWeekNumber } from './calendar.mjs'

export async function prepareLineups(c, date, report) {
  const week = publishedWeekNumber(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${c.seasonYear ?? 2026} AND '${date}' BETWEEN week_start AND week_end`))
  if (week == null) {
    assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}'`), '0', 'A calendar gap cannot hide NBA games')
    report.lineups = { week: null, tieMembers: [], disabledMembers: [], postLockRejections: 0, preferenceChecks: 0, skipped: 'No published fantasy week' }
    return
  }
  const matchups = JSON.parse(await sql(`SELECT coalesce(json_agg(m ORDER BY id),'[]') FROM matchups m WHERE league_season_id='${c.leagueSeasonId}' AND week_number=${week}`))
  const tieMembers = (c.seasonYear ?? 2026) === 2026 && week === 2 && matchups[0] ? [matchups[0].home_member_id, matchups[0].away_member_id] : []
  if (tieMembers.length) c.plannedEmptyWeekMembers = tieMembers
  const manualMembers = new Set(tieMembers)
  for (const user of c.users) {
    const enabled = !manualMembers.has(user.memberId)
    await c.restWrite(user, `lineup_optimizer_settings?league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}`, { enabled, enabled_at: enabled ? `${date}T12:00:00Z` : null }, 'PATCH')
    await c.api(user, '/league/lineup/auto-set-season', { memberId: user.memberId, leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, dates: [date] })
    if (manualMembers.has(user.memberId)) {
      const players = JSON.parse(await sql(`SELECT coalesce(json_agg(player_id),'[]') FROM roster_players WHERE league_season_id='${c.leagueSeasonId}' AND member_id='${user.memberId}' AND NOT is_on_ir AND NOT is_on_taxi`))
      await c.rpc(user, 'set_player_slot_moves_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_league_season_id: c.leagueSeasonId, p_game_date: date, p_week_number: week, p_moves: players.map(player_id => ({ player_id, slot_type: 'BE' })) })
    }
  }
  report.lineups = { week, tieMembers, disabledMembers: [...manualMembers], postLockRejections: 0, preferenceChecks: 0 }
}

export async function checkLineups(c, date, report) {
  for (const member of report.lineups.disabledMembers) {
    assert.equal(await sql(`SELECT count(*) FROM weekly_lineups WHERE league_season_id='${c.leagueSeasonId}' AND member_id='${member}' AND game_date='${date}' AND slot_type NOT IN ('BE','IR')`), '0', 'Disabled daily preference must preserve an empty manual lineup')
    report.lineups.preferenceChecks++
  }
  if (report.lineups.postLockRejections) return
  const rows = JSON.parse(await sql(`SELECT coalesce(json_agg(t),'[]') FROM (SELECT r.member_id,r.player_id,(SELECT slot_type FROM weekly_lineups w WHERE w.league_season_id=r.league_season_id AND w.member_id=r.member_id AND w.player_id=r.player_id AND w.game_date='${date}') AS current_slot FROM roster_players r JOIN players p ON p.id=r.player_id WHERE r.league_season_id='${c.leagueSeasonId}' AND NOT r.is_on_ir AND NOT r.is_on_taxi AND EXISTS(SELECT 1 FROM nba_games g WHERE g.game_date='${date}' AND p.nba_team IN(g.home_team,g.away_team) AND g.game_time<=now()) LIMIT 1) t`))
  if (!rows.length) return
  const row = rows[0], user = c.users.find(user => user.memberId === row.member_id)
  const before = await sql(`SELECT coalesce(json_agg(l ORDER BY player_id),'[]') FROM weekly_lineups l WHERE league_season_id='${c.leagueSeasonId}' AND member_id='${user.memberId}' AND game_date='${date}'`)
  await c.rpc(user, 'set_player_slot_moves_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_league_season_id: c.leagueSeasonId, p_game_date: date, p_week_number: report.lineups.week, p_moves: [{ player_id: row.player_id, slot_type: row.current_slot === 'UTIL' ? 'BE' : 'UTIL' }] }, 400)
  assert.equal(await sql(`SELECT coalesce(json_agg(l ORDER BY player_id),'[]') FROM weekly_lineups l WHERE league_season_id='${c.leagueSeasonId}' AND member_id='${user.memberId}' AND game_date='${date}'`), before, 'Rejected post-lock edit must be atomic')
  report.lineups.postLockRejections++
}

export async function handleIrReturn(c, date, report) {
  const rows = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM roster_players r JOIN players p ON p.id=r.player_id WHERE r.league_season_id='${c.leagueSeasonId}' AND r.is_on_ir AND NOT private.is_ir_designation(p.injury_status)`))
  for (const row of rows) {
    const user = c.users.find(user => user.memberId === row.member_id)
    const free = await sql(`SELECT p.id FROM players p WHERE p.nba_id IS NOT NULL AND p.position IS NOT NULL AND p.injury_status IS NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL) LIMIT 1`)
    const blocked = await c.rpc(user, 'add_free_agent_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_player_id: free }, 400)
    assert.match(JSON.stringify(blocked), /IR|injured reserve/i, 'A healthy IR return must block acquisitions with a clear reason')
    const active = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM roster_players r WHERE league_season_id='${c.leagueSeasonId}' AND member_id='${user.memberId}' AND NOT is_on_ir AND NOT is_on_taxi`))
    if (active.length >= 3) {
      await c.api(user, '/league/roster/ir', { rosterPlayerId: row.id, isOnIR: false }, 400)
      await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: active[0].id })
    }
    await c.api(user, '/league/roster/ir', { rosterPlayerId: row.id, isOnIR: false })
    report.irReturns ??= []
    report.irReturns.push({ date, playerId: row.player_id, acquisitionBlocked: true, returnedAfterRoomMade: true, provenance: 'REAL-DERIVED injury change; SYNTHETIC user actions' })
  }
}
