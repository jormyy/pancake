import { gamePhase, type PhaseGame } from './phase'

type RecoveryGame = PhaseGame & { game_time?: string | null }

export function nextLiveRecovery(games: readonly RecoveryGame[], now: number, publicLive: boolean): number | null {
    const interval = publicLive ? 600000 : 20000
    const scheduled = games.filter(game => gamePhase(game) === 'upcoming')
    if (games.some(game => ['live', 'finalPending'].includes(gamePhase(game))) || scheduled.some(game => {
        const time = Date.parse(game.game_time ?? '')
        return Number.isFinite(time) && time <= now && now - time < 6 * 60 * 60_000
    })) return interval
    const times = scheduled.map(game => Date.parse(game.game_time ?? '')).filter(time => Number.isFinite(time) && time > now)
    if (times.length) return Math.min(Math.min(...times) - now, 2_147_483_647)
    return scheduled.some(game => !Number.isFinite(Date.parse(game.game_time ?? ''))) ? interval : null
}
