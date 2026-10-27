import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { startingSlots } from './position-oracle.mjs'

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function officialProfile({ snapshotHashes, actionSeed, purpose = 'development' }) {
  return validateProfile({
    version: 1, name: 'official', purpose, actionSeed, snapshotHashes,
    teamCount: 10, auctionBudget: 1000,
    settings: {
      roster_size: 20, ir_slots: 2, taxi_slots: 3, taxi_max_seasons: 2,
      taxi_rule: 'rookies_or_64_games', weekly_add_limit: 2,
      waiver_mode: 'faab', faab_starting_budget: 100,
      playoff_entrants: 4, playoff_start_week: 18, playoff_round_lengths: [2, 2],
      skipped_weeks: [1], allow_inactive_trades: true,
      trade_deadline: '2025-02-11', trade_veto_mode: 'member_vote',
      trade_veto_window_hours: 24, trade_veto_threshold_percent: 50,
      scoring_settings: { points: 1, rebounds: 1, assists: 2, steals: 4, blocks: 4, turnovers: -2, field_goals_made: 2, field_goals_attempted: -1, free_throws_made: 1, free_throws_attempted: -1, three_pointers_made: 1, double_double: 0, triple_double: 0 },
    },
    slots: [...['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].map(slot_type => ({ slot_type, slot_count: 1 })), { slot_type: 'UTIL', slot_count: 3 }, { slot_type: 'BE', slot_count: 10 }, { slot_type: 'IR', slot_count: 2 }],
    firstYear: 2025, secondSeasonThrough: '2025-11-03', checkpointDaysBeforePlayoffs: 14,
    optimizerEnabled: true,
  })
}

export function validateProfile(input) {
  const value = structuredClone(input)
  const keys = ['version', 'name', 'purpose', 'actionSeed', 'snapshotHashes', 'teamCount', 'auctionBudget', 'settings', 'slots', 'firstYear', 'secondSeasonThrough', 'checkpointDaysBeforePlayoffs', 'optimizerEnabled']
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Scenario profile must contain exactly the supported fields')
  assert.equal(value.version, 1)
  assert.equal(value.name, 'official')
  assert.ok(['development', 'held-out'].includes(value.purpose), 'Scenario purpose must be explicit')
  assert.match(value.actionSeed, /^[a-zA-Z0-9_-]{8,80}$/, 'Action seed must be explicit and reproducible')
  assert.ok(Array.isArray(value.snapshotHashes) && value.snapshotHashes.length >= 2, 'Official configuration snapshots must be pinned')
  for (const hash of value.snapshotHashes) assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(value.teamCount, 10)
  assert.equal(value.auctionBudget, 1000)
  assert.equal(value.firstYear, 2025)
  assert.equal(value.secondSeasonThrough, '2025-11-03')
  assert.equal(value.checkpointDaysBeforePlayoffs, 14)
  assert.equal(value.optimizerEnabled, true)
  const settings = value.settings
  assert.deepEqual(Object.keys(settings).sort(), ['roster_size', 'ir_slots', 'taxi_slots', 'taxi_max_seasons', 'taxi_rule', 'weekly_add_limit', 'waiver_mode', 'faab_starting_budget', 'playoff_entrants', 'playoff_start_week', 'allow_inactive_trades', 'trade_deadline', 'trade_veto_mode', 'trade_veto_window_hours', 'trade_veto_threshold_percent', 'skipped_weeks', 'playoff_round_lengths', 'scoring_settings'].sort())
  for (const [key, expected] of Object.entries({ roster_size: 20, ir_slots: 2, taxi_slots: 3, taxi_max_seasons: 2, taxi_rule: 'rookies_or_64_games', weekly_add_limit: 2, waiver_mode: 'faab', faab_starting_budget: 100, playoff_entrants: 4, playoff_start_week: 18, allow_inactive_trades: true, trade_deadline: '2025-02-11', trade_veto_mode: 'member_vote', trade_veto_window_hours: 24, trade_veto_threshold_percent: 50 })) assert.equal(settings[key], expected, `Official setting ${key}`)
  assert.deepEqual(settings.skipped_weeks, [1])
  assert.deepEqual(settings.playoff_round_lengths, [2, 2])
  assert.equal(startingSlots(value.slots).length, 10)
  for (const slot of ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']) assert.equal(value.slots.find(row => row.slot_type === slot)?.slot_count, 1, `Official slot ${slot}`)
  assert.equal(value.slots.find(row => row.slot_type === 'UTIL')?.slot_count, 3)
  assert.equal(value.slots.find(row => row.slot_type === 'BE')?.slot_count, 10)
  assert.equal(value.slots.find(row => row.slot_type === 'IR')?.slot_count, 2)
  const scoreKeys = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'field_goals_made', 'field_goals_attempted', 'free_throws_made', 'free_throws_attempted', 'three_pointers_made', 'double_double', 'triple_double']
  assert.deepEqual(Object.keys(settings.scoring_settings).sort(), scoreKeys.sort())
  assert.deepEqual(scoreKeys.map(key => settings.scoring_settings[key]), scoreKeys.map(key => ({ points: 1, rebounds: 1, assists: 2, steals: 4, blocks: 4, turnovers: -2, field_goals_made: 2, field_goals_attempted: -1, free_throws_made: 1, free_throws_attempted: -1, three_pointers_made: 1, double_double: 0, triple_double: 0 })[key]))
  return freeze(value)
}

export async function loadScenarioProfile(file = process.env.SEASON_SIM_PROFILE) {
  if (!file) return null
  assert.ok(path.isAbsolute(file), 'Scenario profile path must be absolute')
  const profile = validateProfile(JSON.parse(await readFile(file, 'utf8')))
  return { profile, sha256: digest(profile) }
}

export function scenarioBounds(profile, seasons) {
  const first = seasons.find(row => row.year === profile.firstYear)
  const second = seasons.find(row => row.year === profile.firstYear + 1)
  assert.ok(first && second, 'Scenario requires both real historical calendars')
  const week = number => first.calendar.weeks.find(row => row.week_number === number)
  const opening = week(profile.settings.playoff_start_week)
  const end = week(profile.settings.playoff_start_week + profile.settings.playoff_round_lengths.reduce((a, b) => a + b, 0) - 1)
  assert.ok(opening && end, 'Official playoffs must fit the historical calendar')
  const checkpoint = new Date(Date.parse(`${opening.week_start}T12:00:00Z`) - profile.checkpointDaysBeforePlayoffs * 86400000).toISOString().slice(0, 10)
  assert.ok(profile.secondSeasonThrough >= second.start && profile.secondSeasonThrough <= second.end)
  return freeze({ firstStart: first.start, firstEnd: first.end, playoffStart: opening.week_start, playoffEnd: end.week_end, checkpoint, secondStart: second.start, secondThrough: profile.secondSeasonThrough })
}
