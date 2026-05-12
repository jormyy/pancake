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

export const TradeActionBody = {
    type: 'object' as const,
    required: ['memberId'],
    properties: {
        memberId: { type: 'string' as const },
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
    properties: {
        memberId: { type: 'string' as const },
        leagueId: { type: 'string' as const },
        leagueSeasonId: { type: 'string' as const },
        recipientMemberId: { type: 'string' as const },
        offerPlayerIds: { type: 'array' as const, items: { type: 'string' as const }, default: [] },
        requestPlayerIds: { type: 'array' as const, items: { type: 'string' as const }, default: [] },
        offerPickIds: { type: 'array' as const, items: { type: 'string' as const }, default: [] },
        requestPickIds: { type: 'array' as const, items: { type: 'string' as const }, default: [] },
        notes: { type: 'string' as const },
    },
}

export const TradeParams = {
    type: 'object' as const,
    required: ['tradeId'],
    properties: {
        tradeId: { type: 'string' as const },
    },
}

export const WaiverClaimBody = {
    type: 'object' as const,
    required: ['memberId', 'leagueId', 'playerId'],
    properties: {
        memberId: { type: 'string' as const },
        leagueId: { type: 'string' as const },
        playerId: { type: 'string' as const },
        dropPlayerId: { type: ['string', 'null'] as const },
    },
}

export const WaiverCancelBody = {
    type: 'object' as const,
    required: ['memberId'],
    properties: {
        memberId: { type: 'string' as const },
    },
}

export const WaiverClaimParams = {
    type: 'object' as const,
    required: ['claimId'],
    properties: {
        claimId: { type: 'string' as const },
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
        leagueId: { type: 'string' as const },
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

export const IRBody = {
    type: 'object' as const,
    required: ['rosterPlayerId', 'isOnIR'],
    properties: {
        rosterPlayerId: { type: 'string' as const },
        isOnIR: { type: 'boolean' as const },
    },
}

export const DraftOrderBody = {
    type: 'object' as const,
    properties: {
        seasonYear: { type: 'integer' as const },
    },
}
