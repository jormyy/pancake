export const LeagueIdBody = {
    type: 'object' as const,
    required: ['leagueId'],
    properties: {
        leagueId: { type: 'string' as const },
    },
}

export const DraftParams = {
    type: 'object' as const,
    required: ['draftId'],
    properties: {
        draftId: { type: 'string' as const },
    },
}

export const NominateBody = {
    type: 'object' as const,
    required: ['memberId', 'playerId'],
    properties: {
        memberId: { type: 'string' as const },
        playerId: { type: 'string' as const },
    },
}

export const BidBody = {
    type: 'object' as const,
    required: ['memberId', 'nominationId', 'amount'],
    properties: {
        memberId: { type: 'string' as const },
        nominationId: { type: 'string' as const },
        amount: { type: 'integer' as const },
    },
}

export const SnakePickBody = {
    type: 'object' as const,
    required: ['memberId', 'playerId'],
    properties: {
        memberId: { type: 'string' as const },
        playerId: { type: 'string' as const },
    },
}

export const NotifyTradeBody = {
    type: 'object' as const,
    required: ['memberId', 'title', 'body'],
    properties: {
        memberId: { type: 'string' as const },
        title: { type: 'string' as const },
        body: { type: 'string' as const },
    },
}

export const SyncStatsBody = {
    type: 'object' as const,
    properties: {
        days: { type: 'integer' as const, default: 1 },
    },
}

export const SyncMatchupsBody = {
    type: 'object' as const,
    properties: {
        force: { type: 'boolean' as const, default: false },
    },
}

export const BackfillBody = {
    type: 'object' as const,
    required: ['seasonYear'],
    properties: {
        seasonYear: { type: 'integer' as const },
        fromDate: { type: 'string' as const },
        toDate: { type: 'string' as const },
        forceResync: { type: 'boolean' as const, default: false },
    },
}

export const BackfillParams = {
    type: 'object' as const,
    required: ['jobId'],
    properties: {
        jobId: { type: 'string' as const },
    },
}

export const VerifyStatsBody = {
    type: 'object' as const,
    properties: {
        sampleSize: { type: 'integer' as const, default: 10 },
    },
}

export const ValidateDbBody = {
    type: 'object' as const,
    properties: {
        seasonYear: { type: 'integer' as const },
    },
}

export const TaxiBody = {
    type: 'object' as const,
    required: ['rosterPlayerId', 'isOnTaxi'],
    properties: {
        rosterPlayerId: { type: 'string' as const },
        isOnTaxi: { type: 'boolean' as const },
    },
}

export const DraftOrderBody = {
    type: 'object' as const,
    properties: {
        seasonYear: { type: 'integer' as const },
    },
}
