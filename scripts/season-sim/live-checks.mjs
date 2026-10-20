import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'
import { checkMatchupPoints, checkWeeklyRows } from './score-oracle.mjs'

export async function assertClientScores(c, { week = null, previous = {}, expectedCount = null } = {}) {
  const read = `matchups?select=*&league_id=eq.${c.leagueId}&league_season_id=eq.${c.leagueSeasonId}&is_voided=eq.false&order=week_number,id`
  const all = await c.rest(c.users[0], read)
  const matchups = all.filter(row => week == null || row.week_number <= week && (row.end_week_number ?? row.week_number) >= week)
  const input = await sqlJson(`SELECT json_build_object('starterLimit',(SELECT sum(slot_count) FROM lineup_slot_templates WHERE league_id='${c.leagueId}' AND slot_type='UTIL'),'settings',(SELECT scoring_settings FROM leagues WHERE id='${c.leagueId}'),'starters',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT l.member_id,l.week_number,l.game_date AS lineup_date,s.* FROM weekly_lineups l JOIN player_game_stats s ON s.player_id=l.player_id JOIN nba_games g ON g.id=s.game_id AND g.game_date=l.game_date WHERE l.league_season_id='${c.leagueSeasonId}' AND l.slot_type NOT IN ('BE','IR') AND g.game_time<=now()) r),'candidates',(SELECT coalesce(json_agg(r),'[]') FROM (SELECT l.member_id,l.week_number,l.game_date AS lineup_date,s.* FROM weekly_lineups l JOIN player_game_stats s ON s.player_id=l.player_id JOIN nba_games g ON g.id=s.game_id AND g.game_date=l.game_date WHERE l.league_season_id='${c.leagueSeasonId}' AND l.slot_type <> 'IR' AND g.game_time<=now()) r))`, 'Live client score inputs')
  const slots = await c.rest(c.users[0], `lineup_slot_templates?select=slot_type,slot_count&league_id=eq.${c.leagueId}`)
  assert.ok(slots.every(row => row.slot_count === 0 || ['UTIL', 'BE', 'IR'].includes(row.slot_type)), 'Independent maximum oracle requires the declared UTIL/bench scenario')
  return { ...checkMatchupPoints({ matchups, ...input, previous, expectedCount }), route: `/rest/v1/${read}`, matchups }
}

export async function assertClosedWeeks(c, date, checked = []) {
  const weeks = await sqlJson(`SELECT coalesce(json_agg(w ORDER BY week_number),'[]') FROM season_weeks w WHERE season_year=(SELECT season_year FROM league_seasons WHERE id='${c.leagueSeasonId}') AND week_end<'${date}' AND week_end>='${c.firstDate ?? '2025-10-21'}' AND week_number<(SELECT playoff_start_week FROM leagues WHERE id='${c.leagueId}') AND NOT week_number=ANY(coalesce((SELECT skipped_weeks FROM leagues WHERE id='${c.leagueId}'),ARRAY[]::int[]))`, 'Closed weeks')
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
