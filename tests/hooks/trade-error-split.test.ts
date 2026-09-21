import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

// Round-3 #25 / round-4 #2 and #6: add/remove and load-more failures are not
// load errors, and a refresh (the banner's own recovery) clears them.
const mocks = vi.hoisted(() => ({
    getTradeBlockItems: vi.fn(async () => []),
    getRoster: vi.fn(async () => []),
    addTradeBlockItem: vi.fn(async () => { throw new Error('listing rejected') }),
    removeTradeBlockItem: vi.fn(async () => undefined),
    getTradesForScreen: vi.fn(async () => ({ trades: [], nextCursor: { id: 'c' }, hasMore: true })),
}))
vi.mock('@/lib/trades', () => ({
    withTradeBlockStats: (items: unknown[]) => items,
    getTradeBlockItems: mocks.getTradeBlockItems,
    addTradeBlockItem: mocks.addTradeBlockItem,
    removeTradeBlockItem: mocks.removeTradeBlockItem,
    getTradesForScreen: mocks.getTradesForScreen,
}))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.getRoster }))
vi.mock('@/lib/roster-stats', () => ({ EMPTY_AVG_MAP: new Map(), EMPTY_STATS_MAP: new Map(), getRosterStatsMaps: vi.fn(async () => ({ avgMap: new Map(), avgStatsMap: new Map() })) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('useTradeBlock action errors', () => {
    it('reports a failed add as actionError, keeps error null, and clears it on refresh', async () => {
        const { useTradeBlock } = await import('@/hooks/use-trade-block')
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => { latest = useTradeBlock('member-1', 'league-1'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await flush()
        expect(latest.error).toBeNull()

        await act(async () => { await latest.addPlayer({ id: 'rp-1', player_id: 'p-1', players: { id: 'p-1' } } as never) })
        await flush()
        expect(latest.actionError).toBe('listing rejected')
        expect(latest.error).toBeNull()

        await act(async () => { await latest.refresh() })
        await flush()
        expect(latest.actionError).toBeNull()
        await act(async () => { renderer.unmount() })
    })
})

describe('useTradesFeed load-more errors', () => {
    it('reports a failed next page as loadMoreError, keeps the first page, and clears it on refresh', async () => {
        const { useTradesFeed } = await import('@/hooks/use-trades-feed')
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = () => { latest = useTradesFeed('member-1', 'league-1'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await flush()
        expect(latest.error).toBeNull()
        expect(latest.hasMore).toBe(true)

        mocks.getTradesForScreen.mockImplementationOnce(async () => { throw new Error('page 2 failed') })
        await act(async () => { await latest.loadMore() })
        await flush()
        expect(latest.loadMoreError).toBe('page 2 failed')
        expect(latest.error).toBeNull()

        await act(async () => { await latest.refresh() })
        await flush()
        expect(latest.loadMoreError).toBeNull()
        await act(async () => { renderer.unmount() })
    })
})
