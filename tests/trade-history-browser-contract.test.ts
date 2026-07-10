import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8')

describe('trade history browser contract', () => {
    it('uses a participant-owned, server-filtered history resource', () => {
        const client = read('lib/trades.ts')
        const screen = read('app/(tabs)/trades.tsx')

        const historyQuery = client.slice(client.indexOf('export async function getTradeHistoryForScreen'))
        expect(historyQuery).toContain(".from('trade_participants')")
        expect(historyQuery).toContain(".eq('member_id', memberId)")
        expect(historyQuery).toContain(".neq('trades.status', 'pending')")
        expect(historyQuery).toContain('tradeHistoryCursorFilter(parsedCursor)')
        expect(historyQuery).toContain('.limit(limit)')
        expect(screen).toContain('useTradeHistoryFeed')
        expect(screen).not.toContain('historyTrades.length === 0 && tradesHaveMore')
        expect(screen).toContain("tab === 'offers' && offersHaveMore")
    })
})
