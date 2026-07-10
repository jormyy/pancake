import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import {
    parseTradeHistoryCursor,
    tradeHistoryCursorFilter,
    tradeHistoryCursorToken,
} from '@/lib/trades'

describe('trade history keyset cursor', () => {
    it('round-trips the stable proposed-at and trade-id boundary', () => {
        const boundary = { proposedAt: '2026-07-09T12:34:56.000Z', tradeId: 'trade-id' }
        const parsed = parseTradeHistoryCursor({ token: tradeHistoryCursorToken(boundary) })

        expect(parsed).toEqual(boundary)
        expect(tradeHistoryCursorFilter(parsed!)).toBe(
            'proposed_at.lt.2026-07-09T12:34:56.000Z,and(proposed_at.eq.2026-07-09T12:34:56.000Z,trade_id.lt.trade-id)',
        )
    })

    it('rejects malformed client cursors before building a database filter', () => {
        expect(() => parseTradeHistoryCursor({ token: 'not-json' })).toThrow('Trade history cursor is invalid.')
    })
})
