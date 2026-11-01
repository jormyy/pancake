import { readLiveSnapshot } from '../_shared/liveSnapshot.ts'
import type { Database } from '../_shared/database.ts'
import type { LiveSnapshot } from '../_shared/liveSnapshot.ts'

export type CheckpointGame = Database['public']['Functions']['get_live_checkpoint_work']['Returns'][number]
export type LiveTick = { lines: number; keepRunning: boolean; worked: boolean; failures: string[]; scoreRetries: number; tickRetries: number; sourceMode?: 'public' | 'database' }
export const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000

export function createCheckpointPoller(dependencies: {
  load: () => Promise<CheckpointGame[]>
  snapshot: (date: string) => Promise<unknown>
  ingest: (holder: string, gameIds?: ReadonlySet<string>, checkpointOnly?: boolean) => Promise<LiveTick>
  record: (holder: string, gameIds: string[]) => Promise<void>
  now?: () => number
}) {
  const now = dependencies.now ?? Date.now
  let work: CheckpointGame[] | undefined
  return async (holder: string): Promise<LiveTick> => {
    work ??= await dependencies.load()
    if (!work.length) return { lines: 0, keepRunning: false, worked: false, failures: [], scoreRetries: 0, tickRetries: 0 }
    const snapshots = new Map<string,LiveSnapshot>()
    await Promise.all([...new Set(work.map(game => game.game_date))].map(async date => {
      const snapshot = readLiveSnapshot(await dependencies.snapshot(date),date,now())
      if (!snapshot) throw new Error('Shared live snapshot is stale or invalid')
      snapshots.set(date,snapshot)
    }))
    if ([...snapshots.values()].some(snapshot => snapshot.mode === 'database')) {
      work = undefined
      return { ...await dependencies.ingest(holder), sourceMode: 'database' }
    }
    const due = new Set<string>()
    let checkpointOnly = true
    for (const game of work) {
      if (game.needs_final_check) { due.add(game.id); checkpointOnly = false; continue }
      const matches = snapshots.get(game.game_date)!.games.filter(row => row.nbaId === game.nba_game_id
        || row.nbaId == null && row.home.team === game.home_team && row.away.team === game.away_team)
      if (matches.length > 1) throw new Error(`Shared game identity is ambiguous: ${game.nba_game_id}`)
      const snapshot = matches[0]
      if (!snapshot) {
        if (game.status === 'InProgress') throw new Error(`Shared live game is unavailable: ${game.nba_game_id}`)
        continue
      }
      if (snapshot.status === 'Scheduled') continue
      if (game.status !== snapshot.status || !game.checkpoint_at || now() - Date.parse(game.checkpoint_at) >= CHECKPOINT_INTERVAL_MS) {
        due.add(game.id)
        checkpointOnly &&= game.status === 'InProgress' && snapshot.status === 'InProgress' && Boolean(game.checkpoint_at)
      }
    }
    let result: LiveTick = { lines: 0, keepRunning: true, worked: true, failures: [], scoreRetries: 0, tickRetries: 0 }
    if (due.size) {
      result = await dependencies.ingest(holder,due,checkpointOnly)
      if (result.worked && !result.failures.length) {
        await dependencies.record(holder,[...due])
        work = await dependencies.load()
      }
    }
    return { ...result, sourceMode: 'public', keepRunning: work.some(game => game.status !== 'Final' || game.needs_final_check) }
  }
}
