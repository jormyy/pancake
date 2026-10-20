import assert from 'node:assert/strict'

export const roundPoints = value => Math.sign(value) * Math.round(Math.abs(Number(value.toFixed(8))) * 100) / 100
const categories = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'three_pointers_made', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted']

export function statPoints(stats, settings) {
  if (stats.did_not_play) return 0
  const doubles = ['points', 'rebounds', 'assists', 'steals', 'blocks'].filter(key => Number(stats[key]) >= 10).length
  const base = categories.reduce((sum, key) => sum + Number(stats[key] ?? 0) * Number(settings[key] ?? 0), 0)
  return roundPoints(base + (doubles >= 2 ? Number(settings.double_double ?? 0) : 0) + (doubles >= 3 ? Number(settings.triple_double ?? 0) : 0))
}

export function expectedWinner(row) {
  if (row.home_points !== row.away_points) return row.home_points > row.away_points ? row.home_member_id : row.away_member_id
  if (row.matchup_type === 'regular_season') return null
  return row.away_max_possible_points > row.home_max_possible_points ? row.away_member_id : row.home_member_id
}

export function checkMatchupPoints({ matchups, starters, candidates = starters, starterLimit = 2, settings, expectedCount, previous = {} }) {
  assert.ok(matchups.length > 0, 'Expected matchup rows must exist')
  if (expectedCount != null) assert.equal(matchups.length, expectedCount, 'Expected matchup count')
  const observations = {}, corrections = []
  for (const matchup of matchups) {
    const observed = { source: {} }
    for (const side of ['home', 'away']) {
      const lines = starters.filter(row => row.member_id === matchup[`${side}_member_id`] && row.week_number >= matchup.week_number && row.week_number <= (matchup.end_week_number ?? matchup.week_number))
      let total = 0
      for (const line of lines) {
        const value = statPoints(line, settings)
        total += value
        observed.source[`${side}:${line.game_id}:${line.player_id}`] = { value, stats: line }
      }
      const expected = roundPoints(total)
      assert.equal(Number(matchup[`${side}_points`]), matchup.is_voided ? 0 : expected, `${matchup.id}: ${side} points from stored stats and locked starters`)
      observed[side] = Number(matchup[`${side}_points`])
      const days = new Map()
      for (const row of candidates.filter(row => row.member_id === matchup[`${side}_member_id`] && row.week_number >= matchup.week_number && row.week_number <= (matchup.end_week_number ?? matchup.week_number))) {
        const key = row.lineup_date ?? row.game_id
        const values = days.get(key) ?? []
        values.push(statPoints(row, settings))
        days.set(key, values)
      }
      const maximum = [...days.values()].reduce((sum, values) => sum + values.sort((a, b) => b - a).slice(0, starterLimit).reduce((total, value) => total + Math.max(0, value), 0), 0)
      if (matchup.is_finalized) assert.equal(Number(matchup[`${side}_max_possible_points`]), roundPoints(maximum), `${matchup.id}: ${side} maximum from daily roster candidates`)
      const before = previous[matchup.id]
      if (before && observed[side] < before[side]) {
        const changes = Object.entries(observed.source).filter(([key, value]) => key.startsWith(`${side}:`) && JSON.stringify(value) !== JSON.stringify(before.source[key]))
        assert.ok(changes.length > 0, `${matchup.id}: live total regresses without a recorded source change`)
        corrections.push({ matchupId: matchup.id, side, from: before[side], to: observed[side], changes, reason: 'Stored source rows change; negative scoring contributions can also reduce totals' })
      }
      if (before?.finalized) assert.equal(observed[side], before[side], 'Final score cannot change after finalization')
    }
    observed.finalized = matchup.is_finalized
    if (matchup.is_finalized && !matchup.is_voided) assert.equal(matchup.winner_member_id, expectedWinner(matchup), `${matchup.id}: winner and tie rule`)
    observations[matchup.id] = observed
  }
  return { observations, corrections, checked: matchups.length * 2 }
}

export function checkWeeklyRows({ matchups, standings, members, week, expectedMatchups }) {
  const weekRows = matchups.filter(row => row.week_number === week && row.matchup_type === 'regular_season' && !row.is_voided)
  assert.equal(weekRows.length, expectedMatchups, `Week ${week}: all expected matchups exist`)
  assert.ok(weekRows.length > 0, `Week ${week}: cannot certify an empty week`)
  assert.ok(weekRows.every(row => row.is_finalized), `Week ${week}: every matchup finalizes automatically`)
  const snapshots = standings.filter(row => row.week_number === week)
  assert.equal(snapshots.length, members.length, `Week ${week}: standings exist for every member`)
  for (const member of members) {
    const actual = snapshots.find(row => row.member_id === member)
    assert.ok(actual, `Week ${week}: missing member standing`)
    const results = matchups.filter(row => row.matchup_type === 'regular_season' && !row.is_voided && row.week_number <= week && [row.home_member_id, row.away_member_id].includes(member))
    const expected = { wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0, max_possible_points: 0 }
    for (const row of results) {
      assert.ok(row.is_finalized, 'Previous weeks must finalize')
      assert.equal(row.winner_member_id, expectedWinner(row), 'Weekly winner follows points')
      expected[row.winner_member_id == null ? 'ties' : row.winner_member_id === member ? 'wins' : 'losses']++
      const home = row.home_member_id === member
      expected.points_for += Number(home ? row.home_points : row.away_points)
      expected.points_against += Number(home ? row.away_points : row.home_points)
      expected.max_possible_points += Number(home ? row.home_max_possible_points : row.away_max_possible_points)
    }
    for (const [key, value] of Object.entries(expected)) assert.equal(Number(actual[key]), roundPoints(value), `Week ${week}: standings ${member}/${key}`)
  }
  return { week, matchups: weekRows.length, standings: snapshots.length, passed: true }
}
