import { calculateFantasyPoints, roundFantasyPoints } from '../scoring/formula'
import type { ScoringSettings, StatLine } from '../scoring/types'
import { liveLineStats } from './codec'
export { liveLineStats } from './codec'

export type LiveLine = [id: string, points: number, rebounds: number, assists: number, steals: number, blocks: number,
    turnovers: number, threesMade: number, fieldGoalsMade: number, fieldGoalsAttempted: number,
    freeThrowsMade: number, freeThrowsAttempted: number, fouls: number, minutes: number, didNotPlay: number]

export type PublicLiveGame = {
    id: string
    nbaId: string | null
    espnId: string | null
    source?: 'nba' | 'espn'
    status: 'Scheduled' | 'InProgress' | 'Final'
    updatedAt: number
    period?: number
    clock?: string
    home: { team: string; score: number; players: LiveLine[] }
    away: { team: string; score: number; players: LiveLine[] }
}

export type LiveSnapshot = { version: 1; mode: 'public' | 'database'; date: string; capturedAt: number; games: PublicLiveGame[] }

export type SavedLivePlayer = {
    playerId: string
    memberId: string
    nbaId: string | null
    espnId: string | null
    team: string | null
    gameId: string | null
    savedPoints: number
    savedAt: number
    starter: boolean
    final?: boolean
}

export type SavedLiveMatchup = {
    id: string
    homeMemberId: string
    awayMemberId: string
    homePoints: number
    awayPoints: number
    finalized: boolean
    ready?: boolean
    players: SavedLivePlayer[]
}

export type PublicLiveStats = StatLine & {
    minutesPlayed: number
    fouls: number
}


export function overlayLiveScores(saved: readonly SavedLiveMatchup[], snapshot: LiveSnapshot | null, settings: ScoringSettings, now: number) {
    const mode = snapshot?.mode ?? 'public'
    const usable = snapshot?.version === 1 && Number.isFinite(snapshot.capturedAt)
        && snapshot.capturedAt <= now + 5000 && now - snapshot.capturedAt <= 120000
    const stats: Record<string, PublicLiveStats> = {}
    const matchups = saved.map(matchup => {
        let homePoints = matchup.homePoints, awayPoints = matchup.awayPoints
        let stale = !matchup.finalized && mode === 'public' && (!usable || matchup.ready === false)
        const pendingStats: Record<string, PublicLiveStats> = {}
        const seen = new Set<string>()
        if (usable && mode === 'public' && !matchup.finalized) for (const player of matchup.players) {
            if (player.final) continue
            const key = `${player.memberId}:${player.playerId}:${player.gameId}`
            if (seen.has(key)) { stale = true; continue }
            seen.add(key)
            const games = snapshot.games.filter(game => player.gameId ? game.nbaId === player.gameId
                || game.nbaId == null && [game.home.team,game.away.team].includes(player.team ?? '')
                : [game.home.team,game.away.team].includes(player.team ?? ''))
            if (!games.length) {
                if (player.gameId) stale = true
                continue
            }
            if (games.length !== 1) { stale = true; continue }
            const game = games[0]
            if (game.status === 'Scheduled') continue
            if (!Number.isFinite(game.updatedAt) || game.updatedAt > now + 5000 || now - game.updatedAt > 120000) { stale = true; continue }
            if (game.updatedAt <= player.savedAt) continue
            const providerId = game.source === 'espn' ? player.espnId : player.nbaId
            const team = [game.home,game.away].find(side => side.team === player.team)
            const rows = (team?.players ?? []).filter(row => row[0] === providerId)
            const values = rows.length === 1 ? liveLineStats(rows[0]) : null
            if (!values) { if (player.starter) stale = true; continue }
            pendingStats[player.playerId] = values
            if (!player.starter) continue
            const delta = calculateFantasyPoints(values, settings) - player.savedPoints
            if (player.memberId === matchup.homeMemberId) homePoints += delta
            else if (player.memberId === matchup.awayMemberId) awayPoints += delta
            else stale = true
        }
        if (!stale) Object.assign(stats, pendingStats)
        return { id: matchup.id, homeMemberId: matchup.homeMemberId, awayMemberId: matchup.awayMemberId,
            homePoints: stale ? matchup.homePoints : roundFantasyPoints(homePoints),
            awayPoints: stale ? matchup.awayPoints : roundFantasyPoints(awayPoints), stale }
    })
    return { mode, matchups, stats, stale: matchups.some(matchup => matchup.stale),
        live: usable && mode === 'public' && snapshot.games.some(game => game.status === 'InProgress') }
}
