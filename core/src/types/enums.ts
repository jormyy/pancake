// Mirrors Database['public']['Enums'] in types/database.ts (the
// Supabase-generated source of truth). Kept in sync manually so @pancake/core
// can be consumed without a Supabase dep. Regenerate by hand whenever an enum
// changes in supabase/migrations.
export type LeagueStatus = 'setup' | 'drafting' | 'active' | 'playoffs' | 'offseason' | 'archived'
export type DraftStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
export type DraftType = 'auction' | 'snake'
export type NominationStatus = 'open' | 'sold' | 'no_bid'
export type TradeStatus =
    | 'pending'
    | 'accepted'
    | 'rejected'
    | 'withdrawn'
    | 'vetoed'
    | 'completed'
    | 'expired'
export type TradeSide = 'proposer' | 'recipient'
export type MatchupType =
    | 'regular_season'
    | 'playoff_quarterfinal'
    | 'playoff_semifinal'
    | 'playoff_final'
export type WaiverClaimStatus =
    | 'pending'
    | 'succeeded'
    | 'failed_priority'
    | 'failed_roster'
    | 'cancelled'
export type RosterSlotType = 'PG' | 'SG' | 'SF' | 'PF' | 'C' | 'G' | 'F' | 'UTIL' | 'BE' | 'IR'
export type NBAPosition = 'PG' | 'SG' | 'SF' | 'PF' | 'C' | 'G' | 'F'
