"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NBA_POSITIONS = exports.ROSTER_SLOT_TYPES = exports.WAIVER_CLAIM_STATUSES = exports.MATCHUP_TYPES = exports.TRADE_SIDES = exports.TRADE_STATUSES = exports.NOMINATION_STATUSES = exports.DRAFT_TYPES = exports.DRAFT_STATUSES = exports.LEAGUE_STATUSES = void 0;
// Mirrors Database['public']['Enums'] in types/database.ts without making
// @pancake/core depend on the generated Supabase client.
exports.LEAGUE_STATUSES = ['setup', 'drafting', 'active', 'playoffs', 'offseason', 'archived'];
exports.DRAFT_STATUSES = ['pending', 'in_progress', 'paused', 'completed', 'cancelled'];
exports.DRAFT_TYPES = ['auction', 'snake'];
exports.NOMINATION_STATUSES = ['open', 'sold', 'no_bid', 'withdrawn'];
exports.TRADE_STATUSES = [
    'pending',
    'accepted',
    'rejected',
    'withdrawn',
    'vetoed',
    'completed',
    'expired',
    'countered',
    'edited',
];
exports.TRADE_SIDES = ['proposer', 'recipient'];
exports.MATCHUP_TYPES = [
    'regular_season',
    'playoff_quarterfinal',
    'playoff_semifinal',
    'playoff_final',
];
exports.WAIVER_CLAIM_STATUSES = ['pending', 'succeeded', 'failed_priority', 'failed_roster', 'cancelled'];
exports.ROSTER_SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'];
exports.NBA_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'];
