import { LiveStatLine } from '@/lib/games'
import { calculateFantasyPoints } from '@pancake/core'
import type { StatLine, ScoringSettings } from '@pancake/core'

function liveStatToLine(stats: LiveStatLine): StatLine {
    return {
        points: stats.points,
        rebounds: stats.rebounds,
        assists: stats.assists,
        steals: stats.steals,
        blocks: stats.blocks,
        turnovers: stats.turnovers ?? 0,
        threePointersMade: stats.threeMade,
        fieldGoalsMade: stats.fgMade,
        fieldGoalsAttempted: stats.fgAttempted,
        freeThrowsMade: stats.ftMade,
        freeThrowsAttempted: stats.ftAttempted,
        doubleDouble: stats.doubleDouble,
        tripleDouble: stats.tripleDouble,
        didNotPlay: stats.didNotPlay,
    }
}

export function computeLiveFantasyPoints(
    stats: LiveStatLine,
    settings: Record<string, number>,
): number {
    return calculateFantasyPoints(liveStatToLine(stats), settings as ScoringSettings)
}

export type Matchup = {
    id: string
    weekNumber: number
    roundStartWeek?: number
    roundEndWeek?: number
    myPoints: number | null
    opponentPoints: number | null
    myTeamName: string
    opponentTeamName: string
    myUsername: string
    opponentUsername: string
    myWins: number
    myLosses: number
    opponentWins: number
    opponentLosses: number
    isFinalized: boolean
    iWon: boolean | null
    myMemberId: string
    opponentMemberId: string
    seasonId: string
    seasonYear: number
}

export type StandingRow = {
    memberId: string
    teamName: string
    wins: number
    losses: number
    ties: number
    pointsFor: number
    pointsAgainst: number
    maxPointsFor: number
}

export function compareStandingsRows(a: StandingRow, b: StandingRow): number {
    const aGames = Math.max(a.wins + a.losses + a.ties, 1)
    const bGames = Math.max(b.wins + b.losses + b.ties, 1)
    const aPoints = a.pointsFor * bGames
    const bPoints = b.pointsFor * aGames
    const pointsDifference = bPoints - aPoints
    const pointsTolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(aPoints), Math.abs(bPoints))
    return (2 * b.wins + b.ties) * aGames - (2 * a.wins + a.ties) * bGames ||
        (Math.abs(pointsDifference) <= pointsTolerance ? 0 : pointsDifference) ||
        b.maxPointsFor - a.maxPointsFor ||
        a.pointsAgainst - b.pointsAgainst ||
        a.teamName.localeCompare(b.teamName) ||
        a.memberId.localeCompare(b.memberId)
}

export type LeagueWeekMatchup = {
    id: string
    homeMemberId: string
    awayMemberId: string
    homeTeamName: string
    awayTeamName: string
    homePoints: number | null
    awayPoints: number | null
    isFinalized: boolean
    isMine: boolean
}

export type MatchupContext = Pick<Matchup, 'id' | 'seasonId' | 'seasonYear' | 'weekNumber' | 'myMemberId' | 'opponentMemberId'>
