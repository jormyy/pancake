// Mirrors Database['public']['Enums'] in types/database.ts without making
// @pancake/core depend on the generated Supabase client.
export const LEAGUE_STATUSES = ['setup', 'drafting', 'active', 'playoffs', 'offseason', 'archived'] as const
export type LeagueStatus = typeof LEAGUE_STATUSES[number]

export const DRAFT_STATUSES = ['pending', 'in_progress', 'paused', 'completed', 'cancelled'] as const
export type DraftStatus = typeof DRAFT_STATUSES[number]

export const DRAFT_TYPES = ['auction', 'snake'] as const
export type DraftType = typeof DRAFT_TYPES[number]

export const NOMINATION_STATUSES = ['open', 'sold', 'no_bid', 'withdrawn'] as const
export type NominationStatus = typeof NOMINATION_STATUSES[number]

export const TRADE_STATUSES = [
    'pending',
    'accepted',
    'rejected',
    'withdrawn',
    'vetoed',
    'completed',
    'expired',
    'countered',
    'edited',
] as const
export type TradeStatus = typeof TRADE_STATUSES[number]

export const TRADE_SIDES = ['proposer', 'recipient'] as const
export type TradeSide = typeof TRADE_SIDES[number]

export const MATCHUP_TYPES = [
    'regular_season',
    'playoff_quarterfinal',
    'playoff_semifinal',
    'playoff_final',
] as const
export type MatchupType = typeof MATCHUP_TYPES[number]

export const WAIVER_CLAIM_STATUSES = ['pending', 'succeeded', 'failed_priority', 'failed_roster', 'cancelled'] as const
export type WaiverClaimStatus = typeof WAIVER_CLAIM_STATUSES[number]

export const ROSTER_SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'] as const
export type RosterSlotType = typeof ROSTER_SLOT_TYPES[number]

export const NBA_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'] as const
export type NBAPosition = typeof NBA_POSITIONS[number]
