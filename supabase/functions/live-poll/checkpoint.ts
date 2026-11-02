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
  discover?: (snapshot: LiveSnapshot) => Promise<void>
  now?: () => number
}) {
  const now = dependencies.now ?? Date.now
  let work: CheckpointGame[] | undefined
  const discovered = new Set<string>()
  return async (holder: string): Promise<LiveTick> => {
    work ??= await dependencies.load()
    const snapshots = new Map<string,LiveSnapshot>()
    await Promise.all([...new Set(work.length ? work.map(game => game.game_date) : [new Date(now()).toLocaleDateString('en-CA',{timeZone:'America/New_York'})])].map(async date => {
      try {
        const snapshot = readLiveSnapshot(await dependencies.snapshot(date),date,now())
        if (snapshot) snapshots.set(date,snapshot)
      } catch { snapshots.delete(date) }
    }))
    if ([...snapshots.values()].some(snapshot => snapshot.mode === 'database')) {
      work = undefined
      return { ...await dependencies.ingest(holder), sourceMode: 'database' }
    }
    const discoveryFailures: string[] = []
    for (const snapshot of snapshots.values()) {
      const unknown = snapshot.games.filter(game => game.status !== 'Scheduled'
        && !work!.some(row => row.nba_game_id === game.nbaId || !game.nbaId && row.game_date === snapshot.date
          && row.home_team === game.home.team && row.away_team === game.away.team)
        && !discovered.has(`${snapshot.date}:${game.id}`))
      if (unknown.length && dependencies.discover) {
        for (const game of unknown) {
          try {
            await dependencies.discover({...snapshot,games:[game]})
            discovered.add(`${snapshot.date}:${game.id}`)
          } catch (error) { discoveryFailures.push(String(error)) }
        }
        work = await dependencies.load()
      }
    }
    const due = new Map<string,boolean>()
    for (const game of work) {
      if (game.needs_final_check) { due.set(game.id,false); continue }
      const overdue = !game.checkpoint_at || now() - Date.parse(game.checkpoint_at) >= CHECKPOINT_INTERVAL_MS
      const matches = (snapshots.get(game.game_date)?.games ?? []).filter(row => row.nbaId === game.nba_game_id
        || row.nbaId == null && row.home.team === game.home_team && row.away.team === game.away_team)
      if (matches.length > 1) { due.set(game.id,false); continue }
      const snapshot = matches[0]
      if (!snapshot) {
        if (overdue) due.set(game.id,game.status === 'InProgress' && Boolean(game.checkpoint_at))
        continue
      }
      if (snapshot.completionPending) { due.set(game.id,false); continue }
      if (snapshot.status === 'Scheduled') {
        if (game.status !== 'Scheduled') due.set(game.id,false)
        continue
      }
      if (game.status !== snapshot.status || !game.checkpoint_at || now() - Date.parse(game.checkpoint_at) >= CHECKPOINT_INTERVAL_MS) {
        due.set(game.id,game.status === 'InProgress' && snapshot.status === 'InProgress' && Boolean(game.checkpoint_at))
      }
    }
    let result: LiveTick = { lines: 0, keepRunning: true, worked: true, failures: discoveryFailures, scoreRetries: 0, tickRetries: 0 }
    let reload = false
    for (const [id,checkpointOnly] of due) {
      try {
        const imported = await dependencies.ingest(holder,new Set([id]),checkpointOnly)
        result.lines += imported.lines
        result.scoreRetries += imported.scoreRetries
        result.tickRetries += imported.tickRetries
        result.failures.push(...imported.failures)
        if (imported.worked && !imported.failures.length) {
          await dependencies.record(holder,[id])
          reload = true
        }
      } catch (error) { result.failures.push(String(error)) }
    }
    if (reload) work = await dependencies.load()
    return { ...result, sourceMode: 'public', keepRunning: work.some(game => game.status !== 'Final' || game.needs_final_check) }
  }
}
