import { runBounded } from '../_shared/runBounded.ts'
import { readLiveSnapshot } from '../_shared/liveSnapshot.ts'
import type { Database } from '../_shared/database.ts'
import type { LiveSnapshot } from '../_shared/liveSnapshot.ts'

export type CheckpointGame = Database['public']['Functions']['get_live_checkpoint_work']['Returns'][number]
export type LiveTick = { lines: number; keepRunning: boolean; worked: boolean; failures: string[]; scoreRetries: number; tickRetries: number; sourceMode?: 'public' | 'database'; importedGameIds?: string[] }
export const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000

export function createCheckpointPoller(dependencies: {
  load: () => Promise<CheckpointGame[]>
  snapshot: (date: string) => Promise<unknown>
  ingest: (holder: string, gameIds?: ReadonlySet<string>, checkpointOnly?: boolean) => Promise<LiveTick>
  record: (holder: string, gameIds: string[]) => Promise<void>
  attempt?: (holder: string, gameId: string) => Promise<void>
  start?: (game: CheckpointGame, signal: AbortSignal) => Promise<void>
  now?: () => number
}) {
  const now = dependencies.now ?? Date.now
  return async (holder: string): Promise<LiveTick> => {
    const deadline = now() + 16000
    const work = await dependencies.load()
    const snapshots = new Map<string,LiveSnapshot>()
    await Promise.all([...new Set(work.map(game => game.game_date))].map(async date => {
      try {
        const snapshot = readLiveSnapshot(await dependencies.snapshot(date),date,now())
        if (snapshot) snapshots.set(date,snapshot)
      } catch { snapshots.delete(date) }
    }))
    if ([...snapshots.values()].some(snapshot => snapshot.mode === 'database')) {
      return {...await dependencies.ingest(holder),sourceMode:'database'}
    }
    const result: LiveTick = {lines:0,keepRunning:false,worked:true,failures:[],scoreRetries:0,tickRetries:0,sourceMode:'public'}
    const startSignal = AbortSignal.timeout(3000)
    await runBounded(work.map(game => async () => {
      const matches = (snapshots.get(game.game_date)?.games ?? []).filter(row => row.nbaId === game.nba_game_id
        || row.nbaId == null && row.home.team === game.home_team && row.away.team === game.away_team)
      const source = matches.length === 1 ? matches[0] : undefined
      if (game.status !== 'Scheduled' || !source || source.status === 'Scheduled'
        || source.updatedAt < now()-120000 || source.updatedAt > now()+5000) return
      try { startSignal.throwIfAborted(); await dependencies.start?.(game,startSignal) }
      catch(error) { result.failures.push(String(error)) }
    }),2)
    for (const game of work) {
      const matches = (snapshots.get(game.game_date)?.games ?? []).filter(row => row.nbaId === game.nba_game_id
        || row.nbaId == null && row.home.team === game.home_team && row.away.team === game.away_team)
      const source = matches.length === 1 ? matches[0] : undefined
      const fresh = source && source.updatedAt >= now()-120000 && source.updatedAt <= now()+5000
      const starting = game.status === 'Scheduled' && fresh && source.status !== 'Scheduled'
      const eastern = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(now()))
      const scheduled = game.status === 'Scheduled' && (game.game_time ? Date.parse(game.game_time) <= now()
        : game.game_date < new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(new Date(now())) || Number(eastern) >= 11)
      const overdue = !game.checkpoint_at || now()-Date.parse(game.checkpoint_at) >= CHECKPOINT_INTERVAL_MS
      const active = game.status === 'InProgress' || game.needs_final_check || starting || scheduled
      result.keepRunning ||= Boolean(active)
      const due = game.needs_final_check || starting || scheduled && overdue
        || game.status === 'InProgress' && (overdue || source?.status === 'Final' || source?.completionPending || source?.status === 'Scheduled')
      if (!due || now() >= deadline) continue
      try {
        await dependencies.attempt?.(holder,game.id)
        const checkpointOnly = game.status === 'InProgress' && source?.status === 'InProgress' && !source.completionPending
        const imported = await dependencies.ingest(holder,new Set([game.id]),checkpointOnly)
        result.lines += imported.lines
        result.scoreRetries += imported.scoreRetries
        result.tickRetries += imported.tickRetries
        result.failures.push(...imported.failures)
        if (imported.worked && !imported.failures.length && imported.importedGameIds?.includes(game.id)) {
          await dependencies.record(holder,[game.id])
        }
      } catch (error) { result.failures.push(String(error)) }
    }
    return result
  }
}
