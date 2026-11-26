import { expect, it } from 'vitest'
import { organizeActivity, type TransactionRow } from '@/lib/transactions'

const at = '2026-11-25T08:00:00.123Z'
const row = (id: string, transactionType: string, memberId: string | null, playerId: string | null, extra: Partial<TransactionRow> = {}): TransactionRow => ({
    id, memberId, teamName: memberId ?? '', playerId, playerName: playerId ?? '', position: null, eligiblePositions: [], nbaId: null, transactionType, occurredAt: at, ...extra,
})

it('merges each FAAB win into its claim and keeps each team together, with lost bids last', () => {
    const rows = [
        row('s1', 'faab_bid_won', null, 'p1', { isSystem: true, targetMemberId: 'a', body: 'P1 won for $12.' }),
        row('lost', 'faab_bid_lost', null, 'p9', { isSystem: true, targetMemberId: 'c' }),
        row('d2', 'waiver_drop', 'b', 'p4'),
        row('a1', 'waiver_add', 'a', 'p1'),
        row('s2', 'faab_bid_won', null, 'p2', { isSystem: true, targetMemberId: 'b', body: 'P2 won for $3.' }),
        row('d1', 'waiver_drop', 'a', 'p3'),
        row('a2', 'waiver_add', 'b', 'p2'),
        row('old', 'fa_add', 'c', 'p5', { occurredAt: '2026-11-24T08:00:00.000Z' }),
    ]
    const organized = organizeActivity(rows)
    expect(organized.map(item => item.id)).toEqual(['a2', 'd2', 'a1', 'd1', 'lost', 'old'])
    expect(organized.find(item => item.id === 'a1')?.bidAmount).toBe(12)
    expect(organized.find(item => item.id === 'a2')?.bidAmount).toBe(3)
})

it('leaves rows from different moments in their order', () => {
    const rows = [row('x', 'fa_add', 'a', 'p1'), row('y', 'fa_drop', 'b', 'p2', { occurredAt: '2026-11-20T00:00:00.000Z' })]
    expect(organizeActivity(rows).map(item => item.id)).toEqual(['x', 'y'])
})
