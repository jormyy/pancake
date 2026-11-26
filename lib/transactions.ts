import type { RosterStatsMaps } from '@/lib/roster-stats'
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
    bidAmount?: number | null
    title?: string
    body?: string | null
    participantTeamNames?: string[]
    tradePlayers?: (Partial<Extract<TradeItem, { kind: 'player' }>> & { kind: 'player'; playerId: string; playerName: string; tradeValue: number | null; fromMemberId: string; toMemberId: string; fromTeamName: string; toTeamName: string })[]
    tradeFaab?: (Extract<TradeItem, { kind: 'faab' }> & { fromMemberId: string; toMemberId: string; fromTeamName: string; toTeamName: string })[]
    tradePicks?: (TradePickItem & { fromTeamName: string; toTeamName: string })[]
}

const ADD_TYPES = new Set(['waiver_add', 'fa_add'])
const DROP_TYPES = new Set(['waiver_drop', 'fa_drop'])
const WIN_EVENTS = new Set(['faab_bid_won', 'waiver_claim_succeeded', 'free_agent_added'])
const LOST_EVENTS = new Set(['faab_bid_lost', 'waiver_claim_failed_priority'])

function batchKey(row: TransactionRow) {
    return row.occurredAt.slice(0, 19)
}

function organizeBatch(batch: TransactionRow[]): TransactionRow[] {
    if (batch.length < 2) return batch
    const adds = new Map(batch.filter(row => ADD_TYPES.has(row.transactionType) && row.playerId).map(row => [row.playerId!, row]))
    const bids = new Map<string, number>()
    const kept = batch.filter(row => {
        if (!row.isSystem || !WIN_EVENTS.has(row.transactionType) || !row.playerId || !adds.has(row.playerId)) return true
        const bid = row.transactionType === 'faab_bid_won' ? /\$(\d+)/.exec(row.body ?? '')?.[1] : undefined
        if (bid !== undefined) bids.set(row.playerId, Number(bid))
        return false
    }).map(row => row.playerId && ADD_TYPES.has(row.transactionType) && bids.has(row.playerId) ? { ...row, bidAmount: bids.get(row.playerId) } : row)
    const teamOrder = new Map<string, number>()
    for (const row of kept) {
        const team = row.memberId ?? row.targetMemberId ?? ''
        if (!teamOrder.has(team)) teamOrder.set(team, teamOrder.size)
    }
    const rank = (row: TransactionRow) => ADD_TYPES.has(row.transactionType) || WIN_EVENTS.has(row.transactionType) ? 0 : DROP_TYPES.has(row.transactionType) ? 1 : 2
    return kept.map((row, index) => ({ row, index })).sort((a, b) => {
        const lostA = LOST_EVENTS.has(a.row.transactionType) ? 1 : 0
        const lostB = LOST_EVENTS.has(b.row.transactionType) ? 1 : 0
        if (lostA !== lostB) return lostA - lostB
        const teamA = teamOrder.get(a.row.memberId ?? a.row.targetMemberId ?? '') ?? 0
        const teamB = teamOrder.get(b.row.memberId ?? b.row.targetMemberId ?? '') ?? 0
        return teamA - teamB || rank(a.row) - rank(b.row) || a.index - b.index
    }).map(entry => entry.row)
}

export function organizeActivity(rows: TransactionRow[]): TransactionRow[] {
    const result: TransactionRow[] = []
    let batch: TransactionRow[] = []
    for (const row of rows) {
        if (batch.length > 0 && batchKey(batch[0]) !== batchKey(row)) {
            result.push(...organizeBatch(batch))
            batch = []
        }
        batch.push(row)
    }
    result.push(...organizeBatch(batch))
    return result
}

export function tradeActivityPlayerIds(rows: TransactionRow[]): string[] {
    return [...new Set(rows.flatMap(row => row.tradePlayers?.map(player => player.playerId) ?? []))].sort()
}

export function withTradeAverages(rows: TransactionRow[], stats: RosterStatsMaps): TransactionRow[] {
    return rows.map(row => row.tradePlayers?.length ? {
        ...row,
        tradePlayers: row.tradePlayers.map(player => ({
            ...player,
            avgFantasyPoints: stats.avgMap.get(player.playerId) ?? null,
            avgMinutesPlayed: stats.avgStatsMap.get(player.playerId)?.avg_minutes_played ?? null,
        })),
    } : row)
}
