import { supabase } from '../lib/supabase'
import { fetchTodaysGames, NBAGame } from '../lib/nba'
import { syncStatsByDate } from './stats'
import { syncScores } from './scores'
import { CONFIG } from '../config'

type PollerMode = 'idle' | 'active'

// Checks if current ET hour is within the NBA game window (11 AM – 1 AM)
function isGameWindow(): boolean {
    const etHour = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    ).getHours()
    return etHour >= 11 || etHour < 1
}

class LiveGamePoller {
    private mode: PollerMode = 'idle'
    private idleTimer: NodeJS.Timeout | null = null
    private statsTimer: NodeJS.Timeout | null = null
    private scoresTimer: NodeJS.Timeout | null = null
    private running = false
    private lastStatsTick = 0
    private lastScoresTick = 0

    start() {
        if (this.running) return
        this.running = true
        console.log('[livePoller] Started.')
        this.scheduleIdleCheck()
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
    }

    private scheduleIdleCheck() {
        if (!this.running) return
        this.idleTimer = setTimeout(() => this.idleTick(), CONFIG.LIVE_POLL_IDLE_MS)
    }

    private async idleTick() {
        if (!this.running) return
        try {
            if (isGameWindow()) {
                const hasLive = await this.checkForLiveGames()
                if (hasLive) {
                    console.log('[livePoller] Live games detected — switching to active mode.')
                    this.switchToActive()
                    return
                }
            }
        } catch (e: any) {
            console.error('[livePoller] Idle tick error:', e.message)
        }
        this.scheduleIdleCheck()
    }

    private switchToActive() {
        this.mode = 'active'
        this.lastStatsTick = 0
        this.lastScoresTick = 0

        this.statsTimer = setInterval(() => this.statsTick(), CONFIG.LIVE_POLL_ACTIVE_STATS_MS)
        this.scoresTimer = setInterval(() => this.scoresTick(), CONFIG.LIVE_POLL_ACTIVE_SCORES_MS)

        // Run immediately on switch
        this.statsTick()
        this.scoresTick()
    }

    private switchToIdle() {
        console.log('[livePoller] All games finished — switching to idle mode.')
        this.mode = 'idle'
        if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null }
        if (this.scoresTimer) { clearInterval(this.scoresTimer); this.scoresTimer = null }
        this.scheduleIdleCheck()
    }

    private async statsTick() {
        if (!this.running) return
        // Debounce: skip if last tick was less than 20s ago (handles interval drift)
        const now = Date.now()
        if (now - this.lastStatsTick < 20_000) return
        this.lastStatsTick = now

        try {
            await syncStatsByDate(new Date())
        } catch (e: any) {
            console.error('[livePoller] Stats tick error:', e.message)
        }
    }

    private async scoresTick() {
        if (!this.running) return
        try {
            const games = await fetchTodaysGames()
            const hasLive = games.some((g) => g.gameStatus === 2)
            const allDone = games.length > 0 && games.every((g) => g.gameStatus === 3)

            // Update nba_games status from live scoreboard
            await updateGameStatuses(games)

            await syncScores()

            if (allDone) {
                // One final stats sync then go idle
                await syncStatsByDate(new Date())
                this.switchToIdle()
            } else if (!hasLive && !allDone) {
                // Games not started yet — stay active but don't spam
            }
        } catch (e: any) {
            console.error('[livePoller] Scores tick error:', e.message)
        }
    }

    private async checkForLiveGames(): Promise<boolean> {
        const games = await fetchTodaysGames()
        return games.some((g) => g.gameStatus === 2)
    }
}

async function updateGameStatuses(games: NBAGame[]) {
    const today = new Date().toISOString().split('T')[0]
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
