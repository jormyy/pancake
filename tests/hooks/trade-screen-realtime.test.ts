import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { useTradeScreenRealtime } from '@/hooks/use-trade-screen-realtime'

const mocks = vi.hoisted(() => ({
    callbacks: null as null | {
        trades: () => void
        tradeBlock: () => void
        draftPicks: () => void
    },
    dispose: vi.fn(() => Promise.resolve()),
    reportCleanup: vi.fn(),
    subscribe: vi.fn(() => ({ topic: 'trades' })),
}))

vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: (callback: () => void) => ({ trigger: callback, cancel: vi.fn() }),
    disposeTableChangeSubscription: mocks.dispose,
    reportRealtimeCleanup: mocks.reportCleanup,
    subscribeToTableChanges: mocks.subscribe,
}))
vi.mock('@/lib/trades-realtime', () => ({
    tradeScreenWatches: (_leagueId: string, callbacks: NonNullable<typeof mocks.callbacks>) => {
        mocks.callbacks = callbacks
        return []
    },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
    mocks.callbacks = null
})

describe('trade screen realtime ownership', () => {
    it('keeps one owner channel across tabs and refreshes history only while visible', async () => {
        const refreshTrades = vi.fn()
        const refreshHistory = vi.fn()
        const refreshTradeBlock = vi.fn()
        const refreshDraftPicks = vi.fn()
        const Probe = ({ tab }: { tab: TradeTabKey }) => {
            useTradeScreenRealtime({
                leagueId: 'league-a',
                memberId: 'member-a',
                activeTab: tab,
                refreshTrades,
                refreshHistory,
                refreshTradeBlock,
                refreshDraftPicks,
            })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { tab: 'offers' })) })
        act(() => { mocks.callbacks?.trades() })
        expect(refreshTrades).toHaveBeenCalledTimes(1)
        expect(refreshHistory).not.toHaveBeenCalled()

        await act(async () => { renderer.update(React.createElement(Probe, { tab: 'history' })) })
        expect(mocks.subscribe).toHaveBeenCalledTimes(1)
        act(() => { mocks.callbacks?.trades() })
        expect(refreshTrades).toHaveBeenCalledTimes(2)
        expect(refreshHistory).toHaveBeenCalledTimes(1)

        await act(async () => { renderer.unmount() })
        expect(mocks.dispose).toHaveBeenCalledTimes(1)
    })
})
