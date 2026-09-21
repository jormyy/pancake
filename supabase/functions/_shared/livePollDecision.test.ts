import { decideLivePoll, gamesDueForStatsRetry, MISSING_STATS_RETRY_MS } from './livePollDecision.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}
const base = { cdnGameCount: 0, dbActiveGames: 0, nowActive: 0, allDone: false, missingFinalStats: 0, leaseLost: false }

Deno.test('an empty slate with nothing pending is idle', () => {
  assert(decideLivePoll(base).action === 'idle', 'expected idle')
})

Deno.test('a Final game with no box score is fetched even when nothing is live (round-3 #6)', () => {
  assert(decideLivePoll({ ...base, missingFinalStats: 1 }).action === 'synced-db-active', 'empty CDN must still sync')
  assert(decideLivePoll({ ...base, cdnGameCount: 3, missingFinalStats: 1 }).action === 'synced', 'CDN slate must sync too')
})

Deno.test('a lost lease stops both write paths (round-3 #19)', () => {
  assert(decideLivePoll({ ...base, missingFinalStats: 1, leaseLost: true }).action === 'lease-lost', 'db-active path')
  assert(decideLivePoll({ ...base, cdnGameCount: 2, nowActive: 1, leaseLost: true }).action === 'lease-lost', 'slate path')
  assert(decideLivePoll({ ...base, cdnGameCount: 2, leaseLost: true }).action === 'status-check', 'no writes, no lease needed')
})

Deno.test('a missing box score is retried on a backoff, not every tick (round-4 #5)', () => {
  const now = new Date('2026-01-10T03:00:00Z')
  const fresh = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const stale = new Date(now.getTime() - MISSING_STATS_RETRY_MS - 1000).toISOString()
  const due = gamesDueForStatsRetry([
    { id: 'covered', updated_at: stale },
    { id: 'fresh-attempt', updated_at: fresh },
    { id: 'due', updated_at: stale },
    { id: 'never-touched', updated_at: null },
  ], new Set(['covered']), now)
  assert(JSON.stringify(due) === JSON.stringify(['due', 'never-touched']), `unexpected due set ${JSON.stringify(due)}`)
})
