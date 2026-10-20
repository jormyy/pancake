import assert from 'node:assert/strict'
import { dates, season } from './common.mjs'

export function launcherCheck(options) {
  assert.ok(!(options['check-first-date'] && options['check-through']), 'Choose one bounded launcher check')
  const through = options['check-through'] ?? (options['check-first-date'] ? season.start : null)
  if (through == null) return null
  assert.match(through, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(through >= season.start && through <= '2025-10-27', 'Launcher checks cover only the first seven historical dates')
  const selected = dates(season.start, through)
  assert.equal(selected.at(-1), through, 'Launcher check requires a real calendar date')
  return { through, days: selected.length, dates: selected, snapshots: through === '2025-10-27' ? ['waiver-week', 'live-week'] : ['waiver-week'], scope: 'Bounded launcher check; not the fresh full replay' }
}
