export type NBAGameRow = {
    id: string
    nba_game_id: string | null
    home_team: string
    away_team: string
    home_score: number
    away_score: number
    status: string        // 'Scheduled' | 'InProgress' | 'Final'
    game_status_text: string | null  // 'Q3 5:23' | 'Halftime' | 'Final'
    game_date: string
    game_time?: string | null
}

export type LiveStatLine = {
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    turnovers: number | null
    threeMade: number
    fgMade: number
    fgAttempted: number
    ftMade: number
    ftAttempted: number
    fouls: number
    doubleDouble: boolean
    tripleDouble: boolean
    minutesPlayed: number | null
    didNotPlay: boolean
}
