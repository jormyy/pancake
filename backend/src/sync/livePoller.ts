import { supabase } from '../lib/supabase'
import { fetchTodaysGames, NBAGame } from '../lib/nba'
import { syncStatsByDate } from './stats'
import { syncScores } from './scores'
import { CONFIG } from '../config'
import { todayET } from '../lib/utils/date'

// Checks if current ET hour is within the NBA game window (11 AM – 1 AM)
function isGameWindow(): boolean {
    const etHour = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    ).getHours()
    return etHour >= 11 || etHour < 1
}

async function withLivePollLease(fn: () => Promise<void>) {
    const { data, error } = await supabase.rpc('try_live_poll_lock' as any)
    if (error) {
        console.error('[livePoller] Failed to acquire live-poll lease:', error.message)
        return
    }
    if (!data) return

    try {
        await fn()
    } finally {
        const { error: releaseError } = await supabase.rpc('release_live_poll_lock' as any)
        if (releaseError) {
            console.error('[livePoller] Failed to release live-poll lease:', releaseError.message)
        }
    }
}

class LiveGamePoller {
    private idleTimer: NodeJS.Timeout | null = null
    private statsTimer: NodeJS.Timeout | null = null
    private scoresTimer: NodeJS.Timeout | null = null
    private running = false
    private lastStatsTick = 0
    private statsInFlight = false
    private scoresInFlight = false
    private finalizedDates = new Set<string>()
    private finalSyncTimers = new Set<NodeJS.Timeout>()

    start() {
        if (this.running) return
        this.running = true
        console.log('[livePoller] Started.')
        // Check immediately instead of waiting for the full idle interval
        this.idleTick()
    }

    stop() {
        this.running = false
        this.clearTimers()
        console.log('[livePoller] Stopped.')
    }

    private clearTimers() {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
        if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null }
        if (this.scoresTimer) { clearInterval(this.scoresTimer); this.scoresTimer = null }
        for (const timer of this.finalSyncTimers) clearTimeout(timer)
        this.finalSyncTimers.clear()
    }

    private scheduleIdleCheck() {
        if (!this.running) return
        this.idleTimer = setTimeout(() => this.idleTick(), CONFIG.LIVE_POLL_IDLE_MS)
    }

    private async idleTick() {
        if (!this.running) return
        try {
            if (isGameWindow() && !this.finalizedDates.has(todayET())) {
                // Switch to active whenever we're in the game window —
                // don't wait for a game to already be InProgress.
                console.log('[livePoller] Game window active — switching to active mode.')
                this.switchToActive()
                return
            }
        } catch (e: any) {
            console.error('[livePoller] Idle tick error:', e.message)
        }
        this.scheduleIdleCheck()
    }

    private switchToActive() {
        if (this.statsTimer || this.scoresTimer) return
        this.lastStatsTick = 0

        this.statsTimer = setInterval(() => this.statsTick(), CONFIG.LIVE_POLL_ACTIVE_STATS_MS)
        this.scoresTimer = setInterval(() => this.scoresTick(), CONFIG.LIVE_POLL_ACTIVE_SCORES_MS)

        // Run immediately on switch
        this.statsTick()
        this.scoresTick()
    }

    private switchToIdle() {
        console.log('[livePoller] All games finished — switching to idle mode.')
        if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null }
        if (this.scoresTimer) { clearInterval(this.scoresTimer); this.scoresTimer = null }
        // Check again in 1 minute — if still in game window with new games, go active again
        this.idleTimer = setTimeout(() => this.idleTick(), 60_000)
    }

    private async statsTick() {
        if (!this.running) return
        if (this.statsInFlight) return
        // Debounce: skip if last tick was less than 10s ago (handles interval drift)
        const now = Date.now()
        if (now - this.lastStatsTick < 10_000) return
        this.lastStatsTick = now

        this.statsInFlight = true
        try {
            await withLivePollLease(async () => {
                // Only sync stats when there are InProgress or recently-Final games today
                const games = await fetchTodaysGames()
                const hasActiveGames = games.some((g) => g.gameStatus === 2 || g.gameStatus === 3)
                if (!hasActiveGames) return

                await syncStatsByDate(new Date())
            })
        } catch (e: any) {
            console.error('[livePoller] Stats tick error:', e.message)
        } finally {
            this.statsInFlight = false
        }
    }

    private async scoresTick() {
        if (!this.running) return
        if (this.scoresInFlight) return
        this.scoresInFlight = true
        try {
            await withLivePollLease(async () => {
                const games = await fetchTodaysGames()
                const hasLive = games.some((g) => g.gameStatus === 2)
                const allDone = games.length > 0 && games.every((g) => g.gameStatus === 3)
                const dateKey = todayET()

                if (games.length === 0) return // no games today, nothing to do

                // Update nba_games status + scores from live scoreboard
                await updateGameStatuses(games)

                if (allDone && this.finalizedDates.has(dateKey)) {
                    this.switchToIdle()
                    return
                }

                if (hasLive || allDone) {
                    await syncScores()
                }

                if (allDone) {
                    // Final stats sync — run now, then again after 2 and 5 minutes
                    // to account for NBA CDN box score cache lag before going idle.
                    this.finalizedDates.add(dateKey)
                    await syncStatsByDate(new Date())
                    await syncScores()
                    const date = new Date()
                    this.scheduleFinalSync(
                        () => withLivePollLease(() => syncStatsByDate(date)),
                        2 * 60_000,
                    )
                    this.scheduleFinalSync(async () => {
                        await withLivePollLease(async () => {
                            await syncStatsByDate(date)
                            await syncScores()
                        })
                    }, 5 * 60_000)
                    this.switchToIdle()
                }
            })
        } catch (e: any) {
            console.error('[livePoller] Scores tick error:', e.message)
        } finally {
            this.scoresInFlight = false
        }
    }

    private scheduleFinalSync(fn: () => void | Promise<void>, delayMs: number) {
        const timer = setTimeout(async () => {
            this.finalSyncTimers.delete(timer)
            await fn()
        }, delayMs)
        this.finalSyncTimers.add(timer)
    }

}

export async function updateGameStatuses(games: NBAGame[]) {
    const today = todayET()
    const { data: dbGames } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, status')
        .eq('game_date', today)
        .not('nba_game_id', 'is', null)

    if (!dbGames?.length) return

    const cdnMap = new Map(games.map((g) => [g.gameId, g]))

    for (const dbGame of dbGames) {
        const g = cdnMap.get(dbGame.nba_game_id!)
        if (!g) continue
        const newStatus = g.gameStatus === 2 ? 'InProgress' : g.gameStatus === 3 ? 'Final' : 'Scheduled'
        await supabase.from('nba_games').update({
            status: newStatus,
            home_score: g.homeTeam.score,
            away_score: g.awayTeam.score,
            game_status_text: g.gameStatusText,
        }).eq('id', dbGame.id)
    }
}

export const livePoller = new LiveGamePoller()
