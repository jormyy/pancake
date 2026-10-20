import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'

export function checkSkippedWeek({ matchups, lineups, standings, week }) {
  assert.equal(matchups.filter(row => row.week_number === week || row.week_number < week && row.end_week_number >= week).length, 0, `Skipped week ${week}: no matchup exists`)
  assert.equal(lineups.filter(row => row.week_number === week).length, 0, `Skipped week ${week}: no fantasy lineup exists`)
  assert.equal(standings.filter(row => row.week_number === week).length, 0, `Skipped week ${week}: no standing is published`)
  return { week, matchups: 0, lineups: 0, standings: 0, passed: true }
}

export async function assertSkippedWeek(c, week) {
  const read = async table => c.rest(c.users[0], `${table}?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  return checkSkippedWeek({ week, matchups: await read('matchups'), lineups: await read('weekly_lineups'), standings: await read('standings') })
}

export async function isSkippedWeek(c, week) {
  const weeks = await sqlJson(`SELECT to_json(skipped_weeks) FROM league_seasons WHERE id='${c.leagueSeasonId}'`, 'Season skipped weeks')
  return weeks.includes(week)
}

export function checkNextSchedule(matchups, members, playoffStart, skippedWeeks) {
  const weeks = Array.from({ length: playoffStart - 1 }, (_, index) => index + 1).filter(week => !skippedWeeks.includes(week))
  assert.equal(matchups.length, weeks.length * members.length / 2, 'Next-season schedule keeps the configured playoff boundary')
  for (const week of weeks) {
    const rows = matchups.filter(row => row.week_number === week && row.matchup_type === 'regular_season' && !row.is_voided)
    assert.equal(rows.length, members.length / 2, `Eligible calendar week ${week} has every matchup`)
    assert.deepEqual(rows.flatMap(row => [row.home_member_id, row.away_member_id]).sort(), [...members].sort(), `Eligible calendar week ${week} uses every member once`)
  }
  return { passed: true, regularWeeks: weeks, playoffStart }
}
