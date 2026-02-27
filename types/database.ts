// TypeScript types for the Supabase database schema.
// Expand each table type as new features are built.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          username: string
          display_name: string | null
          avatar_url: string | null
          timezone: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          username: string
          display_name?: string | null
          avatar_url?: string | null
          timezone?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          username?: string
          display_name?: string | null
          avatar_url?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      leagues: {
        Row: {
          id: string
          name: string
          slug: string
          invite_code: string | null
          status: LeagueStatus
          commissioner_id: string
          roster_size: number
          ir_slots: number
          auction_budget: number
          scoring_settings: Json
          playoff_start_week: number
          trade_deadline: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          invite_code?: string | null
          status?: LeagueStatus
          commissioner_id: string
          roster_size?: number
          ir_slots?: number
          auction_budget?: number
          scoring_settings?: Json
          playoff_start_week?: number
          trade_deadline?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          status?: LeagueStatus
          commissioner_id?: string
          roster_size?: number
          ir_slots?: number
          auction_budget?: number
          scoring_settings?: Json
          playoff_start_week?: number
          trade_deadline?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      league_members: {
        Row: {
          id: string
          league_id: string
          user_id: string
          role: LeagueMemberRole
          team_name: string | null
          joined_at: string
        }
        Insert: {
          id?: string
          league_id: string
          user_id: string
          role?: LeagueMemberRole
          team_name?: string | null
          joined_at?: string
        }
        Update: {
          id?: string
          league_id?: string
          user_id?: string
          role?: LeagueMemberRole
          team_name?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: {
      league_status: LeagueStatus
      league_member_role: LeagueMemberRole
    }
    CompositeTypes: Record<string, never>
  }
}

export type LeagueStatus =
  | 'setup'
  | 'drafting'
  | 'active'
  | 'playoffs'
  | 'offseason'
  | 'archived'

export type LeagueMemberRole = 'commissioner' | 'co_commissioner' | 'manager'

// Convenience row types
export type Profile = Database['public']['Tables']['profiles']['Row']
export type League = Database['public']['Tables']['leagues']['Row']
export type LeagueMember = Database['public']['Tables']['league_members']['Row']
