import assert from 'node:assert/strict'

export function boundaryDueAt(finalizedAt) {
  const grace = Date.parse(finalizedAt) + 48 * 3600000
  assert.ok(Number.isFinite(grace), 'Finalization time is required')
  for (let at = Math.ceil(grace / 60000) * 60000; at < grace + 26 * 3600000; at += 60000) {
    const time = new Date(at).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })
    if (time === '09:00:00') return at
  }
  throw new Error('The next production boundary gate is missing')
}

export function checkBoundaryWait({ finalizedAt, finalized, now }) {
  assert.ok(finalized && finalizedAt && now < boundaryDueAt(finalizedAt), 'Every expected matchup must exist after the first production boundary gate following playoff grace')
}
