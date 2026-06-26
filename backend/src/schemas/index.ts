// Reasonable bounds shared across schemas. UUIDs are 36 chars; we allow a tiny
// bit of slack for the very rare non-UUID id (e.g. boolean-style string flags).
const UUID = { type: 'string' as const, format: 'uuid' as const, maxLength: 64 }
const NOTES_STR = { type: 'string' as const, maxLength: 500 }
const DATE_STR = { type: 'string' as const, maxLength: 32 } // YYYY-MM-DD plus slack

// Bid amounts are auction-draft dollars. MIN_BID is 1 in config; cap at 1M
// to short-circuit any MAX_SAFE_INTEGER style abuse while leaving room for
// odd league budgets.
const BID_AMOUNT = { type: 'integer' as const, minimum: 1, maximum: 1_000_000 }
const SEASON_YEAR = { type: 'integer' as const, minimum: 1946, maximum: 2100 }

// ID arrays for trade proposals. Cap entries and string length so a
// pathological request can't allocate 50MB of payload.
const ID_ARRAY = {
    type: 'array' as const,
    maxItems: 50,
    items: UUID,
    default: [] as string[],
}

export const LeagueIdBody = {
    type: 'object' as const,
    required: ['leagueId'],
    additionalProperties: false,
    properties: {
        leagueId: UUID,
    },
}

export const DraftParams = {
    type: 'object' as const,
    required: ['draftId'],
    additionalProperties: false,
    properties: {
        draftId: UUID,
    },
}

export const NominateBody = {
    type: 'object' as const,
    required: ['memberId', 'playerId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        playerId: UUID,
    },
}

export const BidBody = {
    type: 'object' as const,
    required: ['memberId', 'nominationId', 'amount'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        nominationId: UUID,
        amount: BID_AMOUNT,
    },
}

export const WithdrawNominationBody = {
    type: 'object' as const,
    required: ['memberId', 'nominationId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        nominationId: UUID,
    },
}

export const SnakePickBody = {
    type: 'object' as const,
    required: ['memberId', 'playerId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        playerId: UUID,
    },
}

// Auto-pick selects best available server-side, so only memberId is required.
// Separate from SnakePickBody because that schema's UUID-format check on
// playerId would 400 any auto-pick call (timer-driven path sends no playerId).
export const AutoPickBody = {
    type: 'object' as const,
    required: ['memberId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
    },
}

export const TradeActionBody = {
    type: 'object' as const,
    required: ['memberId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        dropRosterPlayerIds: ID_ARRAY,
    },
}

export const TradeVetoBody = {
    type: 'object' as const,
    required: ['memberId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
    },
}

export const TradeProposeBody = {
    type: 'object' as const,
    required: [
        'memberId',
        'leagueId',
        'leagueSeasonId',
        'recipientMemberId',
        'offerPlayerIds',
        'requestPlayerIds',
        'offerPickIds',
        'requestPickIds',
    ],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        leagueId: UUID,
        leagueSeasonId: UUID,
        recipientMemberId: UUID,
        // offer/request player ids reference roster_players.player_id (UUID).
        offerPlayerIds: ID_ARRAY,
        requestPlayerIds: ID_ARRAY,
        offerPickIds: ID_ARRAY,
        requestPickIds: ID_ARRAY,
        notes: NOTES_STR,
    },
}

export const TradeParams = {
    type: 'object' as const,
    required: ['tradeId'],
    additionalProperties: false,
    properties: {
        tradeId: UUID,
    },
}

export const WaiverClaimBody = {
    type: 'object' as const,
    required: ['memberId', 'leagueId', 'playerId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
        leagueId: UUID,
        playerId: UUID,
        // dropPlayerId references players.id (UUID) or null when no drop is needed.
        // We avoid `format: 'uuid'` here so null values still validate.
        dropPlayerId: { type: ['string', 'null'] as const, maxLength: 64 },
    },
}

export const WaiverCancelBody = {
    type: 'object' as const,
    required: ['memberId'],
    additionalProperties: false,
    properties: {
        memberId: UUID,
    },
}

export const WaiverClaimParams = {
    type: 'object' as const,
    required: ['claimId'],
    additionalProperties: false,
    properties: {
        claimId: UUID,
    },
}

export const SyncStatsBody = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        days: { type: 'integer' as const, minimum: 1, maximum: 365, default: 1 },
    },
}

export const SyncMatchupsBody = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        force: { type: 'boolean' as const, default: false },
        leagueId: UUID,
    },
}

export const BackfillBody = {
    type: 'object' as const,
    required: ['seasonYear'],
    additionalProperties: false,
    properties: {
        seasonYear: SEASON_YEAR,
        fromDate: DATE_STR,
        toDate: DATE_STR,
        forceResync: { type: 'boolean' as const, default: false },
    },
}

export const BackfillParams = {
    type: 'object' as const,
    required: ['jobId'],
    additionalProperties: false,
    properties: {
        jobId: UUID,
    },
}

export const VerifyStatsBody = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        sampleSize: { type: 'integer' as const, minimum: 1, maximum: 1000, default: 10 },
    },
}

export const ValidateDbBody = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        seasonYear: SEASON_YEAR,
    },
}

export const TaxiBody = {
    type: 'object' as const,
    required: ['rosterPlayerId', 'isOnTaxi'],
    additionalProperties: false,
    properties: {
        rosterPlayerId: UUID,
        isOnTaxi: { type: 'boolean' as const },
    },
}

export const IRBody = {
    type: 'object' as const,
    required: ['rosterPlayerId', 'isOnIR'],
    additionalProperties: false,
    properties: {
        rosterPlayerId: UUID,
        isOnIR: { type: 'boolean' as const },
    },
}

export const DraftOrderBody = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
        seasonYear: SEASON_YEAR,
    },
}

// Re-export shared constants so consumers can reuse them if needed.
export const _bounds = { UUID, NOTES_STR, BID_AMOUNT, SEASON_YEAR }
