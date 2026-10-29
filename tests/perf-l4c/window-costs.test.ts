import { expect, it } from 'vitest'
import { edgeWindowCosts } from './window-costs.mjs'

it('separates job starts and database calls without mixing jobs or windows', () => {
  const events = [
    { window: 'live', job: 'live-poll', kind: 'run' },
    { window: 'live', job: 'live-poll', kind: 'request' },
    { window: 'live', job: 'live-poll', kind: 'request' },
    { window: 'idle', job: 'live-poll', kind: 'run' },
    { window: 'live', job: 'sync-stats', kind: 'request' },
  ]
  const costs = [
    { window: 'live', job: 'live-poll', ms: 3 },
    { window: 'live', job: 'live-poll', ms: 4 },
    { window: 'idle', job: 'live-poll', ms: 100 },
    { window: 'live', job: 'sync-stats', ms: 100 },
  ]
  expect(edgeWindowCosts(events, costs, 'live', 'live-poll', 2)).toEqual({ runsPerHour: 2, callsPerHour: 4, databaseMsPerHour: 14 })
  expect(edgeWindowCosts(events, costs, 'live', 'sync-player-injuries', 2)).toEqual({ runsPerHour: 0, callsPerHour: 0, databaseMsPerHour: 0 })
})
