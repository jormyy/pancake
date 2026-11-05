export type HistoryStanding = {
    memberId: string
    teamName: string
    finalRank: number
    regularSeasonRank: number
    wins: number
    losses: number
    ties: number
    pointsFor: number
    pointsAgainst: number
    playoffResult: string
}

export type SeasonHistory = {
    id: string
    year: number
    champion: { memberId: string; teamName: string } | null
    standings: HistoryStanding[]
    stats: { teams: number; games: number; pointsFor: number }
}
