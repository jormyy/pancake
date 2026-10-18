import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeScreenRealtime } from '@/hooks/use-trade-screen-realtime'

const boundary = vi.hoisted(() => ({ reads: vi.fn(), subscriptions: [] as { onStatus?: (status: string) => void }[] }))
vi.mock('@/lib/trades', () => ({ getTradesForScreen: boundary.reads }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: (_name: string, options: typeof boundary.subscriptions[number]) => { boundary.subscriptions.push(options); return {} },
    debounceRealtimeRefresh: (callback: () => void) => ({ trigger: callback, cancel: () => {} }),
    disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('admits fresh online recovery while an older response remains held and ignores its later completion', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    const old = new Promise(resolve => { release = resolve })
    boundary.reads.mockReturnValueOnce(old).mockResolvedValue({ trades: [{ id: 'fresh' }], hasMore: false, nextCursor: null })
    let latest!: ReturnType<typeof useTradesFeed>
    const other = async () => true
    const Probe = ({ online }: { online: boolean }) => {
        latest = useTradesFeed('member', 'league', online, { autoLoad: false })
        useTradeScreenRealtime({ leagueId: 'league', memberId: 'member', activeTab: 'offers', online, initialTradesRead: true,
            refreshTrades: latest.refresh, refreshHistory: other, refreshTradeBlock: other, refreshDraftPicks: other })
        return null
    }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe, { online: true })) })
        await act(async () => { boundary.subscriptions[0].onStatus?.('SUBSCRIBED') })
        expect(latest.loading).toBe(true)
        await act(async () => { renderer.update(React.createElement(Probe, { online: false })) })
        expect(latest.loading).toBe(false)
        expect(latest.isSnapshot).toBe(true)
        await act(async () => { renderer.update(React.createElement(Probe, { online: true })) })
        expect(boundary.reads).toHaveBeenCalledTimes(2)
        expect(latest.trades.map(trade => trade.id)).toEqual(['fresh'])
        expect(latest.isSnapshot).toBe(false)
        await act(async () => { release({ trades: [{ id: 'old' }], hasMore: false, nextCursor: null }); await old })
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(boundary.reads).toHaveBeenCalledTimes(2)
        expect(latest.trades.map(trade => trade.id)).toEqual(['fresh'])
        expect(latest.loading).toBe(false)
        expect(latest.isSnapshot).toBe(false)
    } finally { await act(async () => { release?.({ trades: [], hasMore: false, nextCursor: null }); renderer?.unmount() }); vi.useRealTimers() }
})
