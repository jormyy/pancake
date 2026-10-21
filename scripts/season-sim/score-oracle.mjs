import assert from 'node:assert/strict'

const roundPoints = value => Math.sign(value) * Math.round(Math.abs(Number(value.toFixed(8))) * 100) / 100
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
        const values = days.get(key) ?? new Map()
        const player = row.player_id
        values.set(player, (values.get(player) ?? 0) + statPoints(row, settings))
        days.set(key, values)
      }
      const maximum = [...days.values()].reduce((sum, byPlayer) => sum + [...byPlayer.values()].sort((a, b) => b - a).slice(0, starterLimit).reduce((total, value) => total + Math.max(0, value), 0), 0)
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

export function checkStarterCoverage(matchup, observation, allowedEmptyMembers = []) {
  for (const side of ['home', 'away']) {
    if (allowedEmptyMembers.includes(matchup[`${side}_member_id`])) continue
    assert.ok(Object.keys(observation.source).some(key => key.startsWith(`${side}:`)), `${matchup.id}: ${side} finalized matchup needs starter stat coverage`)
  }
  return true
}

export function rosterCandidates({ stats, transactions, roster, members }) {
  const additions = new Set(['fa_add', 'waiver_add', 'trade_in', 'draft_won', 'carry_over'])
  const removals = new Set(['fa_drop', 'waiver_drop', 'trade_out'])
  const inactive = new Set(['ir_designate', 'taxi_designate'])
  const active = new Set(['ir_return', 'taxi_return'])
  const positions = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'])
  const history = new Map(), current = new Map()
  for (const row of roster) current.set(`${row.member_id}:${row.player_id}`, row)
  for (const row of transactions) {
    const key = `${row.member_id}:${row.player_id}`
    const rows = history.get(key) ?? []
    rows.push(row)
    history.set(key, rows)
  }
  for (const rows of history.values()) rows.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id))
  const candidates = []
  for (const stat of stats) {
    assert.ok(Number.isFinite(Date.parse(stat.game_time)), 'Historical roster eligibility requires the game tipoff')
    const eligible = stat.eligible_positions?.length ? stat.eligible_positions : [stat.position]
    if (!eligible.some(position => positions.has(position))) continue
    for (const member of members) {
      const key = `${member}:${stat.player_id}`, cutoff = Date.parse(stat.game_time)
      const events = (history.get(key) ?? []).filter(row => Date.parse(row.occurred_at) <= cutoff)
      const ownership = events.filter(row => additions.has(row.transaction_type) || removals.has(row.transaction_type))
      let owned = false, available = false
      if (ownership.length) {
        for (const event of events) {
          if (additions.has(event.transaction_type)) { owned = true; available = event.acquired_to_taxi !== true }
          else if (removals.has(event.transaction_type)) { owned = false; available = false }
          else if (owned && inactive.has(event.transaction_type)) available = false
          else if (owned && active.has(event.transaction_type)) available = true
        }
      } else {
        const row = current.get(key)
        if (!row || row.is_on_ir || row.is_on_taxi || row.acquired_at && Date.parse(row.acquired_at) > cutoff) continue
        owned = true
        available = true
        for (const event of events.filter(event => !row.acquired_at || Date.parse(event.occurred_at) >= Date.parse(row.acquired_at))) {
          if (inactive.has(event.transaction_type)) available = false
          else if (active.has(event.transaction_type)) available = true
        }
      }
      if (owned && available) candidates.push({ ...stat, member_id: member })
    }
  }
  return candidates
}
