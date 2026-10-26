import { strict as assert } from 'node:assert'
import { resolveProjectionWeek } from './sync.ts'

const weeks = [
  { week_number: 16, week_start: '2025-02-03', week_end: '2025-02-09' },
  { week_number: 17, week_start: '2025-02-10', week_end: '2025-02-23' },
  { week_number: 18, week_start: '2025-02-24', week_end: '2025-03-02' },
]

Deno.test('a date inside a two-week scoring period resolves to that period and its own Sleeper week', () => {
  assert.deepEqual(resolveProjectionWeek(weeks, '2025-02-19'), { weekNumber: 17, sleeperWeek: 3, weekStart: '2025-02-17', weekEnd: '2025-02-23' })
  assert.deepEqual(resolveProjectionWeek(weeks, '2025-02-11'), { weekNumber: 17, sleeperWeek: 2, weekStart: '2025-02-10', weekEnd: '2025-02-16' })
})

Deno.test('a week that starts on the current Monday still resolves as before', () => {
  assert.deepEqual(resolveProjectionWeek(weeks, '2025-02-24'), { weekNumber: 18, sleeperWeek: 4, weekStart: '2025-02-24', weekEnd: '2025-03-02' })
  assert.deepEqual(resolveProjectionWeek([...weeks].reverse(), '2025-02-05'), { weekNumber: 16, sleeperWeek: 1, weekStart: '2025-02-03', weekEnd: '2025-02-09' })
})

Deno.test('dates outside every scoring week and an empty calendar resolve to nothing', () => {
  assert.equal(resolveProjectionWeek(weeks, '2025-01-30'), null)
  assert.equal(resolveProjectionWeek(weeks, '2025-03-03'), null)
  assert.equal(resolveProjectionWeek(weeks, '2025-07-15'), null)
  assert.equal(resolveProjectionWeek([], '2025-02-19'), null)
})
