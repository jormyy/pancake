import type { Trade } from '@/lib/trades'

export function tradeRosterPlanKey(trade: Trade): string {
    return JSON.stringify([trade.id, trade.version, trade.status,
        trade.routedItems.flatMap(item => item.kind === 'player'
            ? [[item.playerId, item.fromMemberId, item.toMemberId, item.fromTaxi, item.toTaxi, item.toIR]] : []),
        trade.participants.map(participant => [participant.memberId, participant.dropPlayerIds, participant.rosterMoves]),
    ])
}
