import { liveEspnSource, matchEspnGame } from './espn.ts'
import type { EspnEvent } from './espn.ts'
import { prepareLiveSources, liveFailureText } from './fallback.ts'
import { shouldKeepPolling } from './policy.ts'
import { saveScoreboardGames } from './scoreboard.ts'
import { supabase } from '../_shared/supabase.ts'
import { fetchTodaysGames } from '../_shared/nba.ts'
import { syncLiveStatsGames } from '../_shared/syncStats.ts'
import { syncScores } from '../_shared/syncScores.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { errorMessage } from '../_shared/responses.ts'
import { startLeaseHeartbeat } from '../_shared/leaseHeartbeat.ts'
import { LIVE_POLL_LEASE_TTL_SECONDS, LIVE_POLL_LOCK_KEY } from '../_shared/livePoll.ts'
import { withWorkContext, withLiveScoreRetries, withPublicCheckpoint } from '../_shared/workContext.ts'
import { retryDatabaseContention } from '../_shared/databaseRetry.ts'
import type { Database } from '../_shared/database.ts'
import type { LiveGameCache } from '../_shared/liveFeed.ts'
import { createCheckpointPoller } from './checkpoint.ts'
import type { LiveTick } from './checkpoint.ts'
import { fetchLiveSnapshot } from '../_shared/liveSnapshot.ts'

const LIVE_TICK_MS = 30_000
const LIVE_TICK_BUDGET_MS = 18_000
const LIVE_RUN_MS = 110_000

type LiveGame = Omit<Database['public']['Functions']['get_live_poll_work']['Returns'][number], 'live_cache'> & { live_cache?: LiveGameCache }

async function loadWork(gameIds?: ReadonlySet<string>): Promise<LiveGame[]> {
  const request = gameIds
    ? supabase.rpc('get_live_checkpoint_inputs', { p_game_ids: [...gameIds] })
    : supabase.rpc('get_live_poll_work')
  const { data, error } = await request.abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
  return (data ?? []).map(game => ({ ...game, live_cache: (game.live_cache as LiveGameCache | null) ?? undefined }))
}

async function stampAttempts(holder: string, checkedIds: string[], statIds: string[]): Promise<void> {
  if (!checkedIds.length && !statIds.length) return
  const { error } = await supabase.rpc('record_live_poll_attempts', {
    p_holder: holder, p_checked_ids: checkedIds, p_stats_ids: statIds,
  }).abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
}

function hasEspnLiveGame(game: LiveGame, events: EspnEvent[]): boolean {
  if (game.status === 'Final') return false
  try {
    const event = matchEspnGame(game, events)
    return !!event && ['in', 'post'].includes(event.status.type.state)
  } catch (error) {
    console.error(`[live-poll] ESPN game identity failed for ${game.nba_game_id}:`, errorMessage(error))
    return false
  }
}

async function discoverEspnGames(work: LiveGame[], events: EspnEvent[]): Promise<LiveGame[]> {
  const unmatched = events.filter(event => ['in', 'post'].includes(event.status.type.state) &&
    !work.some(game => matchEspnGame(game, [event])))
  if (!unmatched.length) return work
  const dates = [...new Set(unmatched.map(event => new Date(event.date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })))]
  const { data, error } = await supabase.from('nba_games')
    .select('id,nba_game_id,game_date,season_year,week_number,status,game_time,started_at,home_team,away_team,home_score,away_score,game_status_text,stats_synced_at')
    .eq('status', 'Scheduled').like('nba_game_id', '002%').in('game_date', dates)
    .abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
  const existing = new Set(work.map(game => game.id))
  const extra = (data ?? []).filter(game => !existing.has(game.id) && matchEspnGame(game, unmatched))
    .map(game => ({ ...game, needs_scoreboard: true, needs_stats: true })) as LiveGame[]
  return [...work, ...extra]
}

export async function ingestTick(holder: string, onRetry?: () => void, gameIds?: ReadonlySet<string>): Promise<LiveTick> {
  let tickRetries = 0
  const retry = <T>(run: () => Promise<T>, failures?: (result: T) => unknown[]) => retryDatabaseContention(run, {
    failures, onRetry: () => { tickRetries++; onRetry?.() },
  })
  const select = (rows: LiveGame[]) => rows.filter((game): game is LiveGame & { nba_game_id: string } => !!game.nba_game_id && (!gameIds || gameIds.has(game.id)))
  let work = select(await retry(() => loadWork(gameIds)))
  if (!work.length) return { lines: 0, keepRunning: false, worked: false, failures: [], scoreRetries: 0, tickRetries }
  const boardGames = work.filter(game => game.needs_scoreboard)
  await retry(() => stampAttempts(holder, boardGames.filter(game => game.status === 'Scheduled').map(game => game.id), []))
  const dates = [...new Set(work.map(game => game.game_date).filter(Boolean))]
  if (!dates.length) dates.push(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
  const espn = work.some(game => game.status !== 'Final')
    ? liveEspnSource.scoreboard(dates).catch(error => {
      console.warn('[live-poll] ESPN scoreboard unavailable; using NBA:', errorMessage(error))
      return []
    }) : Promise.resolve([])
  const nba = boardGames.length ? fetchTodaysGames(2500).catch(error => {
    console.warn('[live-poll] NBA scoreboard unavailable:', errorMessage(error))
    return []
  }) : Promise.resolve([])
  const [events, nbaScoreboard] = await Promise.all([espn, nba])
  const nbaFinalWork = work.filter(game => game.status !== 'Final' && nbaScoreboard.some(board => board.gameId === game.nba_game_id && board.gameStatus === 3))
  if (boardGames.length) {
    const fallbackBoards = nbaScoreboard.filter(game => game.gameStatus !== 2 ||
      !work.some(stored => stored.nba_game_id === game.gameId && hasEspnLiveGame(stored, events)))
    await retry(() => saveScoreboardGames(gameIds ? fallbackBoards.filter(board => work.some(game => game.nba_game_id === board.gameId)) : fallbackBoards, work))
    work = select(await retry(() => loadWork(gameIds)))
  }
  for (const game of nbaFinalWork) if (!work.some(row => row.id === game.id)) work.push(game)
  work = gameIds ? work : select(await retry(() => discoverEspnGames(work, events)))
  const statsGames = work.filter(game => game.needs_stats || hasEspnLiveGame(game, events) || nbaFinalWork.some(row => row.id === game.id))
  await retry(() => stampAttempts(holder, [], statsGames.filter(game => game.status === 'Final').map(game => game.id)))
  let lines = 0
  let scoreRetries = 0
  const failures: unknown[] = []
  if (statsGames.length) {
    try {
      const sources = await prepareLiveSources(statsGames, events, nbaScoreboard)
      failures.push(...sources.failures)
      const result = await retry(() => syncLiveStatsGames(statsGames, sources), result => result.failures)
      lines = result.statLines
      failures.push(...result.failures)
    } catch (error) {
      failures.push(error)
    }
    try {
      await withLiveScoreRetries(() => syncScores(undefined, new Date(), {
        recoverStats: false, onPublicationRetry: () => { scoreRetries++ },
      }), () => { scoreRetries++ })
    } catch (error) {
      failures.push(error)
    }
  }
  for (const error of failures) console.error('[live-poll] input failed:', error)
  const keepRunning = shouldKeepPolling(work)
  return { lines, keepRunning, worked: true, failures: failures.map(error => liveFailureText(error)), scoreRetries, tickRetries }
}

export async function runLivePoll(request: Request): Promise<Response> {
  const { data: holder, error } = await supabase.rpc('try_live_poll_lease', {
    p_lock_key: LIVE_POLL_LOCK_KEY, p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
  }).abortSignal(AbortSignal.timeout(5000))
  if (error) throw error
  if (!holder) return Response.json({ ok: true, action: 'lease-skip', ticks: 0 })
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('Live ingestion reached its wall-clock limit')), 115_000)
  const heartbeat = startLeaseHeartbeat(async () => {
    const { data, error } = await supabase.rpc('renew_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY, p_holder_id: holder, p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
    }).abortSignal(AbortSignal.timeout(5000))
    if (error) throw error
    return data === true
  }, LIVE_POLL_LEASE_TTL_SECONDS * 1000 * 2 / 3, error => controller.abort(error ?? new Error('Live poll lease lost')))
  try {
    const result = await recordSyncRun('live-poll', async () => {
      const started = Date.now()
      let ticks = 0
      let statLines = 0
      let scoreRetries = 0
      let tickRetries = 0
      const failures: string[] = []
      const sourceModes = new Set<string>()
      const checkpointRetry = <T>(run: () => Promise<T>) => retryDatabaseContention(run,{ onRetry: () => { tickRetries++ } })
      const sharedUrl = Deno.env.get('LIVE_SNAPSHOT_BASE_URL')
      const checkpointTick = sharedUrl ? createCheckpointPoller({
        load: () => checkpointRetry(async () => {
          const { data, error } = await supabase.rpc('get_live_checkpoint_work').abortSignal(AbortSignal.timeout(5000))
          if (error) throw error
          return data ?? []
        }),
        snapshot: async date => (await fetchLiveSnapshot(new URL(`/api/live/${date}`, sharedUrl).href, AbortSignal.timeout(5000))).body,
        ingest: (holder, gameIds, checkpointOnly) => withPublicCheckpoint(Boolean(checkpointOnly), () => ingestTick(holder, () => { tickRetries++ },gameIds)),
        record: (holder, gameIds) => checkpointRetry(async () => {
          const { error } = await supabase.rpc('record_live_checkpoint',{p_holder:holder,p_game_ids:gameIds}).abortSignal(AbortSignal.timeout(5000))
          if (error) throw error
        }),
      }) : null
      for (let next = started; next < started + LIVE_RUN_MS; next += LIVE_TICK_MS) {
        if (controller.signal.aborted || heartbeat.lost) break
        const wait = next - Date.now()
        if (wait > 0) {
          try {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => { clearTimeout(timer); reject(controller.signal.reason) }
              const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve() }, wait)
              controller.signal.addEventListener('abort', onAbort, { once: true })
            })
          } catch { break }
        }
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LIVE_TICK_BUDGET_MS)])
          const tick = await withWorkContext({ signal, livePollHolder: holder }, () => checkpointTick ? checkpointTick(holder) : ingestTick(holder, () => { tickRetries++ }))
          sourceModes.add(tick.sourceMode ?? 'database')
          if (tick.worked) ticks++
          statLines += tick.lines
          scoreRetries += tick.scoreRetries
          failures.push(...tick.failures)
          if (!tick.keepRunning) break
        } catch (error) {
          ticks++
          failures.push(errorMessage(error))
          console.error('[live-poll] tick failed:', error)
        }
      }
      if (controller.signal.aborted || heartbeat.lost) failures.push(errorMessage(controller.signal.reason))
      return {
        result: { ok: failures.length === 0, action: 'loop', ticks, statLines, scoreRetries, tickRetries, sourceModes: [...sourceModes], elapsedMs: Date.now() - started, failures },
        rowsAffected: statLines, failure: failures.length ? failures.join('; ') : null,
      }
    }, request)
    return Response.json(result, { status: result.ok ? 200 : 500 })
  } finally {
    clearTimeout(deadline)
    heartbeat.stop()
    const { error } = await supabase.rpc('release_live_poll_lease', {
      p_lock_key: LIVE_POLL_LOCK_KEY, p_holder_id: holder,
    }).abortSignal(AbortSignal.timeout(5000))
    if (error) console.error('[live-poll] lease release failed:', error)
  }
}
