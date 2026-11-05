import type { MatchupEstimate } from '@pancake/core'

export type MatchupForecast = MatchupEstimate & {
    matchupId: string
    calculatedAt: string
    validUntil?: string
    inputRevision: number
    stale: boolean
    lineupBasis: string
    games: {
        gameId: string
        playerId: string
        memberId: string
        date: string
        projection: number | null
        source: string | null
        sourceAt: string | null
        remainingFraction: number | null
    }[]
}

export type MatchupForecastDisplay = Pick<MatchupForecast, 'stale' | 'tieProbability' | 'missingInputs'> & {
    teams: Pick<MatchupForecast['teams'][number], 'memberId' | 'projectedFinal' | 'currentPoints' | 'winProbability'>[]
    games: Pick<MatchupForecast['games'][number], 'gameId' | 'playerId' | 'memberId'>[]
}
