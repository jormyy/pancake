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
  recordFailure?: (holder: string, gameId: string) => Promise<void>
  discover?: (snapshot: LiveSnapshot) => Promise<void>
  participation?: (game: CheckpointGame, playerIds: string[], observedAt: number) => Promise<void>
  now?: () => number
}) {
  const now = dependencies.now ?? Date.now
  let work: CheckpointGame[] | undefined
  const discovered = new Set<string>()
  let nextGameId: string | undefined
  const participants = new Map<string,Set<string>>()
  return async (holder: string): Promise<LiveTick> => {
    const deadline=now()+16000
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
      const starts = snapshot.games.filter(game => {
        if (game.status === 'Scheduled') return false
        const stored = work!.find(row => row.nba_game_id === game.nbaId || !game.nbaId && row.game_date === snapshot.date
          && row.home_team === game.home.team && row.away_team === game.away.team)
        return stored?.status === 'Scheduled' || !stored && !discovered.has(`${snapshot.date}:${game.id}`)
      })
      if (starts.length && dependencies.discover) {
        for (const game of starts) {
          try {
            await dependencies.discover({...snapshot,games:[game]})
            discovered.add(`${snapshot.date}:${game.id}`)
          } catch (error) { discoveryFailures.push(String(error)) }
        }
        work = await dependencies.load()
      }
    }
    const participantFailures=new Set<string>()
    if (dependencies.participation) for (const game of work) {
      if (game.status==='Final') continue
      const source=snapshots.get(game.game_date)?.games.find(row=>row.nbaId===game.nba_game_id)
      if (!source || source.status!=='InProgress' || source.source==='espn' || source.updatedAt<now()-120000 || source.updatedAt>now()+5000) continue
      const seen=participants.get(game.id) ?? new Set<string>()
      const ids=[...source.home.players,...source.away.players]
        .filter(row=>row[14]===0 && row.slice(1,14).some(value=>typeof value==='number' && value>0))
        .map(row=>row[0]).filter(id=>!seen.has(id))
      if (!ids.length) continue
      try {
        await dependencies.participation(game,ids,source.updatedAt)
        for (const id of ids) seen.add(id)
        participants.set(game.id,seen)
      } catch(error) { discoveryFailures.push(String(error));participantFailures.add(game.id) }
    }
    const due = new Map<string,boolean>()
    for (const game of work) {
      if (participantFailures.has(game.id)) continue
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
      if (overdue && (snapshot.updatedAt < now()-120000 || snapshot.updatedAt > now()+5000)) { due.set(game.id,false); continue }
      if (snapshot.completionPending) { due.set(game.id,false); continue }
      if (snapshot.status === 'Scheduled') {
        if (game.status !== 'Scheduled' || overdue && (!game.game_time || Date.parse(game.game_time)<=now())) due.set(game.id,false)
        continue
      }
      if (game.status !== snapshot.status || !game.checkpoint_at || now() - Date.parse(game.checkpoint_at) >= CHECKPOINT_INTERVAL_MS) {
        due.set(game.id,game.status === 'InProgress' && snapshot.status === 'InProgress' && Boolean(game.checkpoint_at))
      }
    }
    let result: LiveTick = { lines: 0, keepRunning: true, worked: true, failures: discoveryFailures, scoreRetries: 0, tickRetries: 0 }
    let reload = false
    const recordFailure=async(id:string)=>{
      try { await dependencies.recordFailure?.(holder,id) }
      catch(error) { result.failures.push(String(error)) }
    }
    const entries=[...due]
    const first=Math.max(0,entries.findIndex(([id])=>id===nextGameId))
    const pending=[...entries.slice(first),...entries.slice(0,first)]
    for (const [index,[id,checkpointOnly]] of pending.entries()) {
      if (now()>=deadline) break
      nextGameId=pending[(index+1)%pending.length][0]
      try {
        const imported = await dependencies.ingest(holder,new Set([id]),checkpointOnly)
        result.lines += imported.lines
        result.scoreRetries += imported.scoreRetries
        result.tickRetries += imported.tickRetries
        result.failures.push(...imported.failures)
        if (imported.worked && !imported.failures.length && (!imported.importedGameIds || imported.importedGameIds.includes(id))) {
          await dependencies.record(holder,[id])
          reload = true
        } else await recordFailure(id)
      } catch (error) { result.failures.push(String(error));await recordFailure(id) }
    }
    if (reload) work = await dependencies.load()
    return { ...result, sourceMode: 'public', keepRunning: work.some(game => game.status !== 'Final' || game.needs_final_check) }
  }
}
