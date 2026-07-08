export type TradePerspectiveParticipant = {
    memberId: string
    acceptedAt: string | null
}

export type TradePerspectiveInput = {
    status: string
    proposerMemberId: string
    recipientMemberId: string
    participants: TradePerspectiveParticipant[]
}

export function tradeParticipantIds(
    trade: Pick<TradePerspectiveInput, 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
): string[] {
    return [...new Set([
        trade.proposerMemberId,
        trade.recipientMemberId,
        // Tolerate legacy/cached trades saved before `participants` existed.
        ...(trade.participants ?? []).map((participant) => participant.memberId),
    ].filter(Boolean))]
}

export function isTradeParticipant(
    trade: Pick<TradePerspectiveInput, 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    return memberId.length > 0 && tradeParticipantIds(trade).includes(memberId)
}

export function needsMemberAcceptance(
    trade: Pick<TradePerspectiveInput, 'status' | 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    if (trade.status !== 'pending' || trade.proposerMemberId === memberId || !isTradeParticipant(trade, memberId)) {
        return false
    }

    const participant = trade.participants.find((row) => row.memberId === memberId)
    if (participant) return participant.acceptedAt == null

    return trade.recipientMemberId === memberId
}

export function isIncomingTradeForMember(
    trade: Pick<TradePerspectiveInput, 'status' | 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    return needsMemberAcceptance(trade, memberId)
}

export function isOutgoingTradeForMember(
    trade: Pick<TradePerspectiveInput, 'status' | 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    return trade.status === 'pending'
        && isTradeParticipant(trade, memberId)
        && !needsMemberAcceptance(trade, memberId)
}

export function isVetoableTradeForMember(
    trade: Pick<TradePerspectiveInput, 'status' | 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    return trade.status === 'accepted' && !isTradeParticipant(trade, memberId)
}

export function isTradeHistoryForMember(
    trade: Pick<TradePerspectiveInput, 'status' | 'proposerMemberId' | 'recipientMemberId' | 'participants'>,
    memberId: string,
): boolean {
    return trade.status !== 'pending' && isTradeParticipant(trade, memberId)
}
