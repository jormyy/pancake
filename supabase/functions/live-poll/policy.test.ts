import { equal } from 'node:assert/strict'
import { shouldKeepPolling } from './policy.ts'

Deno.test('the worker follows the selector for a delayed Scheduled game', () => {
  const delayed = { status: 'Scheduled', needs_scoreboard: true, game_time: '2026-03-26T23:00:00Z' }
  equal(shouldKeepPolling([delayed]), true)
})

Deno.test('the worker stops for throttled Scheduled games and stats-only Finals', () => {
  equal(shouldKeepPolling([{ status: 'Scheduled', needs_scoreboard: false }]), false)
  equal(shouldKeepPolling([{ status: 'Final', needs_scoreboard: false }]), false)
  equal(shouldKeepPolling([]), false)
})

Deno.test('the worker keeps polling games in progress', () => {
  equal(shouldKeepPolling([{ status: 'InProgress', needs_scoreboard: true }]), true)
})
