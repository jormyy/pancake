import { expect, it } from 'vitest'
import { organizeActivity, tradeActivityPlayerIds, withTradeAverages, type TransactionRow } from '@/lib/transactions'

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

it('fills completed-trade players with the shared season averages and keeps missing players distinct from zero', () => {
    const traded = (playerId: string) => ({ kind: 'player' as const, playerId, playerName: playerId, tradeValue: null, fromMemberId: 'a', toMemberId: 'b', fromTeamName: 'A', toTeamName: 'B' })
    const trade = row('t', 'trade_completed', 'a', null, { tradePlayers: [traded('star'), traded('bench'), traded('rookie')] })
    const add = row('w', 'fa_add', 'a', 'p1')
    expect(tradeActivityPlayerIds([add, trade])).toEqual(['bench', 'rookie', 'star'])
    const stats = { avgMap: new Map([['star', 41.27], ['bench', 0]]), avgStatsMap: new Map([['star', { avg_minutes_played: 34.6 }], ['bench', { avg_minutes_played: 0 }]]) }
    const [plain, enriched] = withTradeAverages([add, trade], stats as never)
    expect(plain).toBe(add)
    expect(enriched.tradePlayers?.map(({ playerId, avgFantasyPoints, avgMinutesPlayed }) => [playerId, avgFantasyPoints, avgMinutesPlayed])).toEqual([
        ['star', 41.27, 34.6], ['bench', 0, 0], ['rookie', null, null],
    ])
})
