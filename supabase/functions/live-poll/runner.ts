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
import { withWorkContext } from '../_shared/workContext.ts'
import type { Database } from '../_shared/database.ts'

const LIVE_TICK_MS = 20_000
const LIVE_TICK_BUDGET_MS = 18_000
const LIVE_RUN_MS = 110_000

type LiveGame = Database['public']['Functions']['get_live_poll_work']['Returns'][number]

async function loadWork(): Promise<LiveGame[]> {
  const { data, error } = await supabase.rpc('get_live_poll_work')
  if (error) throw error
  return data ?? []
}

async function stampAttempts(holder: string, checkedIds: string[], statIds: string[]): Promise<void> {
  if (!checkedIds.length && !statIds.length) return
  const { error } = await supabase.rpc('record_live_poll_attempts', {
    p_holder: holder, p_checked_ids: checkedIds, p_stats_ids: statIds,
  })
  if (error) throw error
}

async function ingestTick(holder: string): Promise<{ lines: number; keepRunning: boolean; worked: boolean; failures: string[]; scoreRetries: number }> {
  let work = await loadWork()
  if (!work.length) return { lines: 0, keepRunning: false, worked: false, failures: [], scoreRetries: 0 }
  const boardGames = work.filter(game => game.needs_scoreboard)
  if (boardGames.length) {
    await stampAttempts(holder, boardGames.map(game => game.id), [])
    const games = await recordSyncRun('source:nba-cdn-scoreboard', async () => {
      const games = await fetchTodaysGames()
      return { result: games, rowsAffected: games.length }
    }).catch(error => {
      console.error('[live-poll] scoreboard unavailable:', errorMessage(error))
      return []
    })
    await saveScoreboardGames(games, work)
    work = await loadWork()
  }
  const statsGames = work.filter(game => game.needs_stats)
  await stampAttempts(holder, [], statsGames.filter(game => game.status === 'Final').map(game => game.id))
  let lines = 0
  let scoreRetries = 0
  const failures: unknown[] = []
  if (statsGames.length) {
    try {
      const result = await syncLiveStatsGames(statsGames)
      lines = result.statLines
      failures.push(...result.failures)
    } catch (error) {
      failures.push(error)
    }
    try {
      await syncScores(undefined, new Date(), { recoverStats: false, onPublicationRetry: () => { scoreRetries++ } })
    } catch (error) {
      failures.push(error)
    }
  }
  for (const error of failures) console.error('[live-poll] input failed:', error)
  const keepRunning = shouldKeepPolling(work)
  return { lines, keepRunning, worked: true, failures: failures.map(errorMessage), scoreRetries }
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
  }, LIVE_POLL_LEASE_TTL_SECONDS * 1000 / 3, error => controller.abort(error ?? new Error('Live poll lease lost')))
  try {
    const result = await recordSyncRun('live-poll', async () => {
      const started = Date.now()
      let ticks = 0
      let statLines = 0
      let scoreRetries = 0
      const failures: string[] = []
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
          const tick = await withWorkContext({ signal, livePollHolder: holder }, () => ingestTick(holder))
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
        result: { ok: failures.length === 0, action: 'loop', ticks, statLines, scoreRetries, elapsedMs: Date.now() - started, failures },
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
