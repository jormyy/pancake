export type ClaimDraft = {
    bid: string
    dropPlayerId: string | null
    toIr: boolean | null
    toTaxi: boolean | null
}

export function isClaimDraft(value: unknown): value is ClaimDraft {
    if (!value || typeof value !== 'object') return false
    const draft = value as Record<string, unknown>
    return typeof draft.bid === 'string' && /^\d*$/.test(draft.bid)
        && (draft.dropPlayerId === null || typeof draft.dropPlayerId === 'string')
        && (draft.toIr === null || typeof draft.toIr === 'boolean')
        && (draft.toTaxi === null || typeof draft.toTaxi === 'boolean')
}
