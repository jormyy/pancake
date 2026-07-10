type TradePerspectiveParticipant = {
    memberId: string
    acceptedAt: string | null
}

export type TradePerspectiveInput = {
    status: string
    proposerMemberId: string
    recipientMemberId: string
    participants: TradePerspectiveParticipant[]
}

type RoutedTradeAsset = { fromMemberId: string; toMemberId: string }

type TradeDisplayInput<Item extends RoutedTradeAsset> = Pick<
    TradePerspectiveInput,
    'proposerMemberId' | 'recipientMemberId' | 'participants'
> & {
    proposerTeamName: string
    recipientTeamName: string
    routedItems: Item[]
}

export function tradeDisplayPerspective<Item extends RoutedTradeAsset>(
    trade: TradeDisplayInput<Item>,
    memberId: string,
) {
    if (isTradeParticipant(trade, memberId)) {
        return {
            receives: trade.routedItems.filter((item) => item.toMemberId === memberId),
            gives: trade.routedItems.filter((item) => item.fromMemberId === memberId),
            receiveLabel: 'You receive:',
            giveLabel: 'You give:',
        }
    }

    return {
        receives: trade.routedItems.filter((item) => item.toMemberId === trade.recipientMemberId),
        gives: trade.routedItems.filter((item) => item.toMemberId === trade.proposerMemberId),
        receiveLabel: `${trade.recipientTeamName} receives:`,
        giveLabel: `${trade.proposerTeamName} receives:`,
    }
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
    if (trade.status !== 'pending' || !isTradeParticipant(trade, memberId)) {
        return false
    }

    const participant = trade.participants.find((row) => row.memberId === memberId)
    if (participant) return participant.acceptedAt == null

    return trade.recipientMemberId === memberId && trade.proposerMemberId !== memberId
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
