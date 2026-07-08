import type { LeagueStatus, LeagueMemberRole, Json } from './database'

type WaiverMode = 'rolling' | 'faab'
type TradeVetoMode = 'disabled' | 'commissioner' | 'member_vote'

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
    trade_deadline?: string | null
    weekly_add_limit?: number | null
    waiver_mode?: WaiverMode
    faab_starting_budget?: number
    trade_veto_mode?: TradeVetoMode
    trade_veto_window_hours?: number
    trade_veto_threshold_percent?: number
    deleted_at?: string | null
    deleted_by?: string | null
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
