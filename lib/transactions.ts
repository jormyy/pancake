import type { TradeItem, TradePickItem } from '@/lib/trades'

export { TRANSACTION_LABELS, activityEventCategory } from '@/lib/shared/transaction-labels'

export type TransactionRow = {
    id: string
    memberId: string | null
    targetMemberId?: string | null
    teamName: string
    targetTeamName?: string | null
    playerId: string | null
    playerName: string
    position: string | null
    eligiblePositions: string[]
    nbaId: string | null
    nbaTeam?: string | null
    injuryStatus?: string | null
    yearsExp?: number | null
    careerGames?: number | null
    transactionType: string
    occurredAt: string
    isSystem?: boolean
    title?: string
    body?: string | null
    participantTeamNames?: string[]
    tradePlayers?: (Partial<Extract<TradeItem, { kind: 'player' }>> & { kind: 'player'; playerId: string; playerName: string; tradeValue: number | null; fromMemberId: string; toMemberId: string; fromTeamName: string; toTeamName: string })[]
    tradeFaab?: (Extract<TradeItem, { kind: 'faab' }> & { fromMemberId: string; toMemberId: string; fromTeamName: string; toTeamName: string })[]
    tradePicks?: (TradePickItem & { fromTeamName: string; toTeamName: string })[]
}
