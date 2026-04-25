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

/**
 * Player data commonly used across the app.
 */
export interface PlayerInfo {
    id: string
    display_name: string
    first_name?: string
    last_name?: string
    nba_team?: string | null
    position?: string | null
    eligible_positions?: string[] | null
    injury_status?: string | null
    nba_id?: string | null
    sleeper_id?: string | null
    headshot_url?: string | null
}

/**
 * Fantasy scoring settings shape.
 */
export interface ScoringSettings {
    pts?: number
    reb?: number
    ast?: number
    stl?: number
    blk?: number
    to?: number
    fg_pct?: number
    ft_pct?: number
    dd_bonus?: number
    td_bonus?: number
}

/**
 * Member profile as returned from nested select.
 */
export interface MemberProfile {
    id: string
    user_id: string
    role: LeagueMemberRole
    team_name: string | null
    display_name?: string | null
    username?: string | null
}
