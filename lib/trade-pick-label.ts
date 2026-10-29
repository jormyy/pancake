import { pickLabel } from '@/lib/picks'
import type { Trade, TradePickItem } from '@/lib/trades'

export type TradePickContext = {
    viewerMemberId: string
    memberNames: Readonly<Record<string, string>>
}

export function tradePickContext(trade: Pick<Trade, 'participants' | 'proposerMemberId' | 'proposerTeamName' | 'recipientMemberId' | 'recipientTeamName'>, viewerMemberId: string): TradePickContext {
    return {
        viewerMemberId,
        memberNames: {
            [trade.proposerMemberId]: trade.proposerTeamName,
            [trade.recipientMemberId]: trade.recipientTeamName,
            ...Object.fromEntries(trade.participants.map(participant => [participant.memberId, participant.teamName])),
        },
    }
}

export function tradePickLabel(pick: TradePickItem, context?: TradePickContext): string {
    const memberName = (memberId: string | null | undefined) => memberId && memberId === context?.viewerMemberId
        ? 'You' : memberId && context?.memberNames[memberId] || 'Unknown team'
    return `${pickLabel(pick.seasonYear, pick.round)} (orig. ${pick.originalTeamName}) — from ${memberName(pick.fromMemberId)} → to ${memberName(pick.toMemberId)}`
}
