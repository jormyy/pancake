import { season } from './common.mjs'
import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'
import { checkMatchupPoints, checkWeeklyRows, checkStarterCoverage, rosterCandidates } from './score-oracle.mjs'

export async function assertClientScores(c, { week = null, previous = {}, expectedCount = null } = {}) {
  const read = `matchups?select=*&league_id=eq.${c.leagueId}&league_season_id=eq.${c.leagueSeasonId}&is_voided=eq.false&order=week_number,id`
  const all = await c.rest(c.users[0], read)
  const matchups = all.filter(row => week == null || row.week_number <= week && (row.end_week_number ?? row.week_number) >= week)
  assert.ok(matchups.length > 0, 'Expected client matchup rows must exist')
  const span = week == null ? '' : `AND l.week_number BETWEEN ${Math.min(...matchups.map(row => row.week_number))} AND ${Math.max(...matchups.map(row => row.end_week_number ?? row.week_number))}`
  const input = await sqlJson(`SELECT json_build_object('slots',(SELECT json_agg(json_build_object('slot_type',slot_type,'slot_count',slot_count)) FROM lineup_slot_templates WHERE league_id='${c.leagueId}'),'starterLimit',(SELECT sum(slot_count) FROM lineup_slot_templates WHERE league_id='${c.leagueId}' AND slot_type='UTIL'),'settings',(SELECT scoring_settings FROM leagues WHERE id='${c.leagueId}'),'starters',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT l.member_id,l.week_number,l.game_date AS lineup_date,s.* FROM weekly_lineups l JOIN player_game_stats s ON s.player_id=l.player_id JOIN nba_games g ON g.id=s.game_id AND g.game_date=l.game_date WHERE l.league_season_id='${c.leagueSeasonId}' ${span} AND l.slot_type NOT IN ('BE','IR') AND g.game_time<=now()) r))`, 'Live client score inputs')
  if (matchups.some(row => row.is_finalized)) {
    const startWeek = Math.min(...matchups.map(row => row.week_number)), endWeek = Math.max(...matchups.map(row => row.end_week_number ?? row.week_number))
    const history = await sqlJson(`SELECT json_build_object('roster',(SELECT coalesce(json_agg(r),'[]') FROM roster_players r WHERE league_season_id='${c.leagueSeasonId}'),'transactions',(SELECT coalesce(json_agg(t),'[]') FROM roster_transactions t WHERE league_season_id='${c.leagueSeasonId}'),'stats',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT s.*,g.week_number,g.game_time,g.game_date AS lineup_date,p.position,p.eligible_positions FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id JOIN players p ON p.id=s.player_id WHERE g.season_year=${c.seasonYear ?? season.year} AND g.week_number BETWEEN ${startWeek} AND ${endWeek} AND g.game_time<=now() AND s.player_id IN (SELECT player_id FROM roster_players WHERE league_season_id='${c.leagueSeasonId}' UNION SELECT player_id FROM roster_transactions WHERE league_season_id='${c.leagueSeasonId}')) r))`, 'Independent roster-history candidates')
    input.candidates = rosterCandidates({ ...history, members: c.users.map(user => user.memberId) })
  } else input.candidates = []
  assert.equal(input.starterLimit, 2, 'The declared scenario has two UTIL starters')
  assert.ok(input.slots.every(row => row.slot_count === 0 || ['UTIL', 'BE', 'IR'].includes(row.slot_type)), 'Independent maximum oracle requires the declared UTIL/bench scenario')
  const result = checkMatchupPoints({ matchups, ...input, previous, expectedCount })
  for (const matchup of matchups.filter(row => row.is_finalized)) {
    const allowed = (c.seasonYear ?? season.year) === season.year && matchup.week_number === 2 && matchup.matchup_type === 'regular_season' ? c.plannedEmptyWeekMembers ?? [] : []
    checkStarterCoverage(matchup, result.observations[matchup.id], allowed)
  }
  return { ...result, route: `/rest/v1/${read}`, matchups }
}

export async function assertClosedWeeks(c, date, checked = []) {
  const weeks = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=(SELECT season_year FROM league_seasons WHERE id='${c.leagueSeasonId}') AND week_end<'${date}' AND week_end>='${c.firstDate ?? season.start}' AND week_number<(SELECT playoff_start_week FROM leagues WHERE id='${c.leagueId}') AND NOT week_number=ANY(coalesce((SELECT skipped_weeks FROM league_seasons WHERE id='${c.leagueSeasonId}'),ARRAY[]::int[]))`, 'Closed weeks')
  const matchups = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&order=week_number,id`)
  const standings = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${c.leagueSeasonId}&order=week_number,member_id`)
  const members = c.users.map(user => user.memberId)
  assert.ok(members.length >= 2 && members.length % 2 === 0)
  const results = []
  for (const { week_number: week } of weeks.filter(row => !checked.includes(row.week_number))) {
    results.push(checkWeeklyRows({ matchups, standings, members, week, expectedMatchups: members.length / 2 }))
    checked.push(week)
  }
  return results
}
