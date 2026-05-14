export type ScoringSettings = Record<string, number>

export interface StatLine {
    points: number
    rebounds: number
    assists: number
    steals: number
    blocks: number
    turnovers: number
    threePointersMade: number
    fieldGoalsMade: number
    fieldGoalsAttempted: number
    freeThrowsMade: number
    freeThrowsAttempted: number
    doubleDouble: boolean
    tripleDouble: boolean
    didNotPlay: boolean
}
