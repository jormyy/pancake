import assert from 'node:assert/strict'

export function boundaryDueAt(lastGameDate) {
  const grace = Date.parse(`${lastGameDate}T00:00:00Z`) + 24 * 3600000
  assert.ok(Number.isFinite(grace), 'The last game date is required')
  for (let at = Math.ceil(grace / 60000) * 60000; at < grace + 26 * 3600000; at += 60000) {
    const time = new Date(at).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })
    if (time === '09:00:00') return at
  }
  throw new Error('The next production boundary gate is missing')
}

export function checkBoundaryWait({ lastGameDate, finalized, now }) {
  assert.ok(finalized && lastGameDate && now < boundaryDueAt(lastGameDate), 'Every expected matchup must exist after the first production boundary gate after the preceding round ends')
}
