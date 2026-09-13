// Pure decision for one live-poll tick, kept out of the handler so the branch
// logic is testable without a PostgREST stub.
export type LivePollInputs = {
  cdnGameCount: number
  dbActiveGames: number
  nowActive: number
  allDone: boolean
  missingFinalStats: number
  leaseLost: boolean
}

export type LivePollDecision =
  | { action: 'lease-lost' }
  | { action: 'synced-db-active' }
  | { action: 'idle' }
  | { action: 'synced' }
  | { action: 'status-check' }

export function decideLivePoll(input: LivePollInputs): LivePollDecision {
  const wantsSync = input.nowActive > 0 || input.allDone || input.dbActiveGames > 0 || input.missingFinalStats > 0
  if (input.cdnGameCount === 0) {
    if (input.dbActiveGames > 0 || input.missingFinalStats > 0) {
      return input.leaseLost ? { action: 'lease-lost' } : { action: 'synced-db-active' }
    }
    return { action: 'idle' }
  }
  if (wantsSync) return input.leaseLost ? { action: 'lease-lost' } : { action: 'synced' }
  return { action: 'status-check' }
}

// A Final game whose box score keeps failing must not be refetched every
// minute for two days: only games untouched for this long count as missing.
export const MISSING_STATS_RETRY_MS = 30 * 60 * 1000

export function gamesDueForStatsRetry(
  games: Array<{ id: string; updated_at: string | null }>,
  coveredIds: Set<string>,
  now: Date,
): string[] {
  return games
    .filter((game) => !coveredIds.has(game.id))
    .filter((game) => {
      const touched = game.updated_at ? Date.parse(game.updated_at) : NaN
      return Number.isNaN(touched) || now.getTime() - touched >= MISSING_STATS_RETRY_MS
    })
    .map((game) => game.id)
}
