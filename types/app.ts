import type { LeagueStatus, LeagueMemberRole, Json } from './database'

/**
 * League data as returned from Supabase nested select.
 * This is the shape of `leagues` inside a `league_members` row.
 */
export interface LeagueInfo {
    id: string
    name: string
    invite_code: string | null
    status: LeagueStatus
    commissioner_id: string
    auction_budget: number
    scoring_settings: Json
    playoff_start_week: number
    roster_size: number
    ir_slots: number
    taxi_slots?: number
}

/**
 * A league membership row with the nested league object fully typed.
 */
export interface LeagueMembership {
    id: string
    role: LeagueMemberRole
    team_name: string | null
    leagues: LeagueInfo
}

