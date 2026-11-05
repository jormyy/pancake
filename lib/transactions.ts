import type { TradePickItem } from '@/lib/trades'

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
    tradePicks?: (TradePickItem & { fromTeamName: string; toTeamName: string })[]
}
