import { supabase } from '../lib/supabase'
import { fetchTodaysGames, NBAGame } from '../lib/nba'
import { syncStatsByDate } from './stats'
import { syncScores } from './scores'
import { CONFIG } from '../config'

// Checks if current ET hour is within the NBA game window (11 AM – 1 AM)
function isGameWindow(): boolean {
    const etHour = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    ).getHours()
    return etHour >= 11 || etHour < 1
}

// Shared with supabase/functions/live-poll — both pollers must use the same
// lock_key so the lease provides mutual exclusion across the edge function and
// the backend worker.
const LIVE_POLL_LOCK_KEY = 779001
// TTL must comfortably cover the longest in-loop sync. 90s leaves headroom
// over the 1-minute cron cadence; if the worker crashes the lease auto-clears.
const LIVE_POLL_LEASE_TTL_SECONDS = 90

function etDate(offsetDays = 0): string {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() + offsetDays)
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function dateFromISODate(date: string): Date {
    return new Date(`${date}T12:00:00-05:00`)
}

function candidateLiveDates(): string[] {
    return [etDate(-1), etDate()]
}

async function syncStatsForCandidateDates(): Promise<void> {
    for (const date of candidateLiveDates()) {
        await syncStatsByDate(dateFromISODate(date))
    }
}

async function dbActiveGameCount(): Promise<number> {
    const { data, error } = await supabase
        .from('nba_games')
        .select('id')
        .in('game_date', candidateLiveDates())
        .eq('status', 'InProgress')
    if (error) {
        console.error('[livePoller] Failed to read active DB games:', error.message)
        return 0
    }
    return data?.length ?? 0
}

async function withLivePollLease(fn: () => Promise<void>) {
    const { data: holderId, error } = await supabase.rpc('try_live_poll_lease', {
        p_lock_key: LIVE_POLL_LOCK_KEY,
        p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS,
    })
    if (error) {
        console.error('[livePoller] Failed to acquire live-poll lease:', error.message)
        return
    }
    if (!holderId) return

    try {
        await fn()
    } finally {
        const { error: releaseError } = await supabase.rpc('release_live_poll_lease', {
            p_lock_key: LIVE_POLL_LOCK_KEY,
            p_holder_id: holderId,
        })
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
            const hasDbActiveGames = await dbActiveGameCount() > 0
            if ((isGameWindow() && !this.finalizedDates.has(etDate())) || hasDbActiveGames) {
                // Switch to active whenever we're in the game window —
                // don't wait for a game to already be InProgress. Also
                // recover after late-night restarts while DB games are active.
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
                const priorDbActive = await dbActiveGameCount()
                let games: NBAGame[]
                try {
                    games = await fetchTodaysGames()
                } catch (e: any) {
                    if (priorDbActive > 0) {
                        await syncStatsForCandidateDates()
                        return
                    }
                    throw e
                }

                // Only sync stats when the CDN has active/recently-final games
                // or the database still has a candidate-date game marked active.
                const hasActiveGames = priorDbActive > 0 || games.some((g) => g.gameStatus === 2 || g.gameStatus === 3)
                if (!hasActiveGames) return

                await syncStatsForCandidateDates()
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
                const priorDbActive = await dbActiveGameCount()
                let games: NBAGame[]
                try {
                    games = await fetchTodaysGames()
                } catch (e: any) {
                    if (priorDbActive > 0) {
                        await syncStatsForCandidateDates()
                        await syncScores()
                        return
                    }
                    throw e
                }
                const hasLive = games.some((g) => g.gameStatus === 2)
                const allDone = games.length > 0 && games.every((g) => g.gameStatus === 3)

                if (games.length === 0) {
                    if (priorDbActive > 0) {
                        await syncStatsForCandidateDates()
                        await syncScores()
                    }
                    return
                }

                // Update nba_games status + scores from live scoreboard
                const updatedGameDates = await updateGameStatuses(games)
                const dateKeys = updatedGameDates.length > 0 ? updatedGameDates : [etDate()]

                if (allDone && dateKeys.every((dateKey) => this.finalizedDates.has(dateKey))) {
                    this.switchToIdle()
                    return
                }

                const shouldSync = hasLive || allDone || priorDbActive > 0

                if (priorDbActive > 0 && !hasLive && !allDone) {
                    await syncStatsForCandidateDates()
                }

                if (shouldSync) {
                    await syncScores()
                }

                if (allDone) {
                    // Final stats sync — run now, then again after 2 and 5 minutes
                    // to account for NBA CDN box score cache lag before going idle.
                    await syncStatsForCandidateDates()
                    await syncScores()
                    const dates = Array.from(new Set([...candidateLiveDates(), ...dateKeys])).map(dateFromISODate)
                    this.scheduleFinalSync(
                        () => withLivePollLease(async () => {
                            for (const date of dates) await syncStatsByDate(date)
                        }),
                        2 * 60_000,
                    )
                    this.scheduleFinalSync(async () => {
                        await withLivePollLease(async () => {
                            for (const date of dates) await syncStatsByDate(date)
                            await syncScores()
                        })
                    }, 5 * 60_000)
                    for (const dateKey of dateKeys) this.finalizedDates.add(dateKey)
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
            try {
                await fn()
            } catch (e: any) {
                console.error('[livePoller] Final sync error:', e.message)
            }
        }, delayMs)
        this.finalSyncTimers.add(timer)
    }

}

export async function updateGameStatuses(games: NBAGame[]): Promise<string[]> {
    const { data: dbGames, error } = await supabase
        .from('nba_games')
        .select('id, nba_game_id, status, game_date')
        .in('game_date', candidateLiveDates())
        .not('nba_game_id', 'is', null)
    if (error) throw error

    if (!dbGames?.length) return []

    const cdnMap = new Map(games.map((g) => [g.gameId, g]))
    const gameDates = new Set<string>()

    const rows: Array<{
        id: string
        status: string
        home_score: number
        away_score: number
        game_status_text: string
    }> = []
    for (const dbGame of dbGames) {
        const g = cdnMap.get(dbGame.nba_game_id!)
        if (!g) continue
        gameDates.add(dbGame.game_date)
        const newStatus = g.gameStatus === 2 ? 'InProgress' : g.gameStatus === 3 ? 'Final' : 'Scheduled'
        rows.push({
            id: dbGame.id,
            status: newStatus,
            home_score: g.homeTeam.score,
            away_score: g.awayTeam.score,
            game_status_text: g.gameStatusText,
        })
    }

    if (rows.length === 0) return []

    for (const row of rows) {
        const { error } = await supabase
            .from('nba_games')
            .update({
                status: row.status,
                home_score: row.home_score,
                away_score: row.away_score,
                game_status_text: row.game_status_text,
                updated_at: new Date().toISOString(),
            })
            .eq('id', row.id)
        if (error) throw error
    }
    return Array.from(gameDates)
}

export const livePoller = new LiveGamePoller()
