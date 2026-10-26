import assert from 'node:assert/strict'
import test from 'node:test'
import { officialProfile, validateProfile, scenarioBounds, loadScenarioProfile } from './scenario-profile.mjs'

const profile = () => officialProfile({ snapshotHashes: ['a'.repeat(64), 'b'.repeat(64)], actionSeed: 'mission-development' })

test('official rules cannot silently become a small diagnostic or a different league', () => {
  const initial = profile()
  assert.ok(Object.isFrozen(initial.settings))
  for (const corrupt of [row => { row.teamCount = 4 }, row => { row.settings.roster_size = 3 }, row => { row.settings.weekly_add_limit = 1 }, row => { row.settings.trade_veto_mode = 'commissioner' }, row => { row.settings.scoring_settings.assists = 1 }, row => { row.slots[0].slot_count = 0; row.slots[7].slot_count = 4 }, row => { row.snapshotHashes = [] }, row => { row.unrecognized = true }]) {
    const value = structuredClone(initial)
    corrupt(value)
    assert.throws(() => validateProfile(value))
  }
})

test('profile is opt-in and maps playoffs without changing source calendars', async () => {
  assert.equal(await loadScenarioProfile(''), null)
  const seasons = [{ year: 2025, start: '2024-10-22', end: '2025-04-13', calendar: { weeks: [{ week_number: 18, week_start: '2025-02-24', week_end: '2025-03-02' }, { week_number: 21, week_start: '2025-03-17', week_end: '2025-03-23' }] } }, { year: 2026, start: '2025-10-21', end: '2026-04-12' }]
  const before = structuredClone(seasons)
  assert.deepEqual(scenarioBounds(profile(), seasons), { firstStart: '2024-10-22', firstEnd: '2025-04-13', playoffStart: '2025-02-24', playoffEnd: '2025-03-23', checkpoint: '2025-02-10', secondStart: '2025-10-21', secondThrough: '2025-11-03' })
  assert.deepEqual(seasons, before)
})

test('official scoring disables new-league bonuses absent from the saved league', () => {
  const profile = officialProfile({ snapshotHashes: ['a'.repeat(64), 'b'.repeat(64)], actionSeed: 'official-bonuses' })
  assert.equal(profile.settings.scoring_settings.double_double, 0)
  assert.equal(profile.settings.scoring_settings.triple_double, 0)
  const corrupted = structuredClone(profile)
  corrupted.settings.scoring_settings.double_double = 1.5
  assert.throws(() => validateProfile(corrupted))
})
