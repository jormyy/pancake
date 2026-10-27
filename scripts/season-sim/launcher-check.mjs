import assert from 'node:assert/strict'
import { dates, season } from './common.mjs'

export function launcherCheck(options) {
  assert.ok(!options.start || !(options['check-first-date'] || options['check-through']), 'Choose --start or a bounded launcher check')
  assert.ok(!(options['check-first-date'] && options['check-through']), 'Choose one bounded launcher check')
  const through = options['check-through'] ?? (options['check-first-date'] ? season.start : null)
  if (through == null) return null
  assert.match(through, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(through >= season.start && through <= dates(season.start, season.end)[6], 'Launcher checks cover only the first seven historical dates')
  const selected = dates(season.start, through)
  assert.equal(selected.at(-1), through, 'Launcher check requires a real calendar date')
  return { through, days: selected.length, dates: selected, snapshots: through === dates(season.start, season.end)[6] ? ['waiver-week', 'live-week'] : ['waiver-week'], scope: 'Bounded launcher check; not the fresh full replay' }
}

export function launcherStart(options) {
  if (options.start == null) return null
  assert.match(options.start, /^\d{4}-\d{2}-\d{2}$/, '--start requires YYYY-MM-DD')
  assert.equal(new Date(`${options.start}T12:00:00Z`).toISOString().slice(0, 10), options.start, '--start requires a real calendar date')
  return { 'late-season': true, start: options.start }
}

export function lateSeasonCheck(result) {
  assert.equal(result.complete, true, 'Late-season replay must complete')
  assert.equal(result.invariantFailures, 0, 'Late-season replay requires no invariant failures')
  assert.equal(result.gates?.noFailure, true, 'Late-season replay requires no failures')
  assert.equal(result.failure ?? result.error ?? result.cleanupError ?? null, null, 'Late-season replay requires no failure')
  assert.deepEqual(result.failures ?? [], [], 'Late-season replay requires no failures')
  assert.equal(result.lateStart?.passed, true, 'Late-season replay requires all measurable acceptance areas')
  assert.deepEqual(result.lateStart.gaps, [], 'Late-season replay requires no measurable gaps')
  assert.equal(result.fullAcceptance, false, 'Late-season replay cannot certify the full season')
  return { passed: true, complete: result.complete, invariantFailures: result.invariantFailures, failures: result.failures ?? [], lateStart: result.lateStart }
}
