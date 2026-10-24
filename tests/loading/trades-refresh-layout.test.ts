import { describe, expect, it, vi } from 'vitest'
import { buildTradeList, tradeListItemType, tradeListKey, type TradeListItem } from '@/lib/trades-screen-model'
import type { Trade } from '@/lib/trades'

vi.mock('react-native', () => ({ PixelRatio: { roundToNearestPixel: (value: number) => value }, View: 'View' }))

const { RVLinearLayoutManagerImpl } = await vi.importActual<typeof import('@shopify/flash-list/dist/recyclerview/layout-managers/LinearLayoutManager')>('@shopify/flash-list/src/recyclerview/layout-managers/LinearLayoutManager')

const outgoing = { id: 'outgoing', status: 'pending' } as Trade
const input = {
    tab: 'offers' as const, vetoableTrades: [], incomingTrades: [], outgoingTrades: [outgoing],
    historyTrades: [], picks: [], myBlockItems: [], blockLoading: false,
    blockRoster: [], leagueBlockItems: [],
}

const layoutManager = (rows: TradeListItem[]) => new RVLinearLayoutManagerImpl({
    windowSize: { width: 390, height: 844 }, horizontal: false, maxColumns: 1,
    optimizeItemArrangement: false, overrideItemLayout: () => {},
    getItemType: index => tradeListItemType(rows[index]),
})

describe('offer refresh layout', () => {
    it('keeps the incoming empty row and outgoing layout during refresh', () => {
        let rows = buildTradeList({ ...input, tradesLoading: false })
        const manager = layoutManager(rows)
        manager.modifyLayout([], rows.length)
        const paintedIndices = rows.map((_, index) => index)
        const paintedKeys = rows.map(tradeListKey)
        for (let cycle = 0; cycle < 10; cycle++) {
            rows = buildTradeList({ ...input, tradesLoading: true })
            manager.modifyLayout([], rows.length)
            expect(() => paintedIndices.forEach(index => manager.getLayout(index))).not.toThrow()
            expect(rows.map(tradeListKey)).toEqual(paintedKeys)
            rows = buildTradeList({ ...input, tradesLoading: false })
            manager.modifyLayout([], rows.length)
        }
    })

    it('keeps settled empty sections through pending reads and errors', () => {
        const settled = buildTradeList({ ...input, outgoingTrades: [], tradesLoading: false })
        const pending = buildTradeList({ ...input, outgoingTrades: [], tradesLoading: true, tradesSettled: true })
        const failed = buildTradeList({ ...input, outgoingTrades: [], tradesLoading: false, tradesSettled: true, tradesError: true })
        expect(pending).toEqual(settled)
        expect(failed).toEqual(settled)
        expect(buildTradeList({ ...input, outgoingTrades: [], tradesLoading: true }).some(row => row._type === 'empty')).toBe(false)
    })

    it('keeps section identity when earlier trades change', () => {
        const rows = buildTradeList({ ...input, tradesLoading: false })
        const changed = buildTradeList({ ...input, incomingTrades: [outgoing, { ...outgoing, id: 'second-incoming' }], tradesLoading: false })
        const headerKeys = (items: TradeListItem[]) => items.flatMap((row, index) => row._type === 'header' ? [tradeListKey(row, index)] : [])
        expect(headerKeys(rows)).toEqual(headerKeys(changed))
    })
})

describe.each(['block'] as const)('%s refresh layout', tab => {
    it('retains settled empty listings and their layouts through a refresh', () => {
        const settled = buildTradeList({ ...input, tab, tradesLoading: false, blockLoading: false })
        const manager = layoutManager(settled)
        manager.modifyLayout([], settled.length)
        const pending = buildTradeList({ ...input, tab, tradesLoading: false, blockLoading: true, blockSettled: true })
        manager.modifyLayout([], pending.length)
        expect(() => settled.forEach((_, index) => manager.getLayout(index))).not.toThrow()
        expect(pending).toEqual(settled)
        expect(buildTradeList({ ...input, tab, tradesLoading: false, blockError: true, blockSettled: true })).toEqual(settled)
    })
})
