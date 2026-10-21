import assert from 'node:assert/strict'

export function rookieDraftOptions(timerSeconds = 60) {
  assert.ok(Number.isInteger(timerSeconds) && timerSeconds >= 60 && timerSeconds <= 604800, 'Rookie timers range from sixty seconds through seven days')
  return { rounds: 2, timerSeconds, timerExpiryBehavior: 'auto_pick' }
}
