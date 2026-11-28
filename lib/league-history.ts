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

export type HistoryTradeAsset = {
    kind: 'player' | 'pick' | 'faab'
    label: string
}

export type HistoryTradeParticipant = {
    memberId: string
    teamName: string
    received: HistoryTradeAsset[]
}

export type CompletedTradeHistory = {
    id: string
    completedAt: string
    participants: HistoryTradeParticipant[]
}

export type ManagerTradeCount = {
    memberId: string
    teamName: string
    count: number
}
