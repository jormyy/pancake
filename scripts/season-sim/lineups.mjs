import { season } from './common.mjs'
import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'
import { publishedWeekNumber } from './calendar.mjs'

export async function prepareLineups(c, date, report) {
  const week = publishedWeekNumber(await sql(`SELECT week_number FROM season_weeks WHERE season_year=${c.seasonYear ?? season.year} AND '${date}' BETWEEN week_start AND week_end`))
  if (week == null) {
    assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE game_date='${date}'`), '0', 'A calendar gap cannot hide NBA games')
    report.lineups = { week: null, tieMembers: [], disabledMembers: [], postLockRejections: 0, preferenceChecks: 0, skipped: 'No published fantasy week' }
    return
  }
  const matchups = JSON.parse(await sql(`SELECT coalesce(json_agg(m ORDER BY id),'[]') FROM matchups m WHERE league_season_id='${c.leagueSeasonId}' AND week_number=${week}`))
  const tieMembers = (c.seasonYear ?? season.year) === season.year && week === 2 && matchups[0] ? [matchups[0].home_member_id, matchups[0].away_member_id] : []
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
