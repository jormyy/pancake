import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TradeTabKey } from '@/lib/trade-ui-model'
import { useTradeScreenRealtime } from '@/hooks/use-trade-screen-realtime'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' } }))

const mocks = vi.hoisted(() => ({
    callbacks: null as null | {
        trades: () => void
        tradeBlock: () => void
        draftPicks: () => void
    },
    dispose: vi.fn(() => Promise.resolve()),
    reportCleanup: vi.fn(),
    subscribe: vi.fn((_name: string, _options: { onStatus?: (status: string) => void }) => ({ topic: 'trades' })),
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
    it.each([
        ['offers', 'trades', 'trades'],
        ['history', 'trades', 'history'],
        ['block', 'tradeBlock', 'block'],
        ['picks', 'draftPicks', 'picks'],
    ] as const)('retries failed %s change-event reads without another event', async (tab, event, feed) => {
        vi.useFakeTimers()
        const reads = { trades: vi.fn().mockResolvedValue(true), history: vi.fn().mockResolvedValue(true),
            block: vi.fn().mockResolvedValue(true), picks: vi.fn().mockResolvedValue(true) }
        const Probe = () => {
            useTradeScreenRealtime({ leagueId: 'league-a', memberId: 'member-a', activeTab: tab,
                refreshTrades: reads.trades, refreshHistory: reads.history,
                refreshTradeBlock: reads.block, refreshDraftPicks: reads.picks })
            return null
        }
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(Probe)) })
            await act(async () => { mocks.subscribe.mock.calls[0][1].onStatus?.('SUBSCRIBED') })
            for (const read of Object.values(reads)) read.mockClear()
            reads[feed].mockResolvedValueOnce(false)
            await act(async () => { mocks.callbacks?.[event]() })
            expect(reads[feed]).toHaveBeenCalledTimes(1)
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(reads[feed]).toHaveBeenCalledTimes(2)
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(reads[feed]).toHaveBeenCalledTimes(2)
        } finally {
            await act(async () => { renderer.unmount() })
            vi.useRealTimers()
        }
    })

    it('recreates a closed channel only for the current visible owner', async () => {
        vi.useFakeTimers()
        const refreshTrades = vi.fn().mockResolvedValue(true)
        const refreshHistory = vi.fn(), refreshTradeBlock = vi.fn(), refreshDraftPicks = vi.fn()
        const Probe = ({ focused }: { focused: boolean }) => {
            useTradeScreenRealtime({ leagueId: 'league-a', memberId: 'member-a', activeTab: 'offers',
                focused, refreshTrades, refreshHistory, refreshTradeBlock, refreshDraftPicks })
            return null
        }
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(Probe, { focused: true })) })
            const oldStatus = mocks.subscribe.mock.calls[0][1].onStatus
            await act(async () => { oldStatus?.('SUBSCRIBED') })
            await act(async () => { renderer.update(React.createElement(Probe, { focused: false })) })
            await act(async () => { oldStatus?.('CLOSED'); await vi.advanceTimersByTimeAsync(30_000) })
            expect(mocks.subscribe).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { focused: true })) })
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(mocks.subscribe).toHaveBeenCalledTimes(2)
            const currentStatus = mocks.subscribe.mock.calls[1][1].onStatus
            await act(async () => { currentStatus?.('SUBSCRIBED'); oldStatus?.('CLOSED') })
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(mocks.subscribe).toHaveBeenCalledTimes(2)
            await act(async () => { currentStatus?.('CLOSED'); renderer.unmount() })
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(mocks.subscribe).toHaveBeenCalledTimes(2)
        } finally {
            await act(async () => { renderer.unmount() })
            vi.useRealTimers()
        }
    })

    it('retains hidden pick recovery until a pick consumer opens and retries a failed read', async () => {
        vi.useFakeTimers()
        const refreshTrades = vi.fn().mockResolvedValue(true)
        const refreshHistory = vi.fn().mockResolvedValue(true)
        const refreshTradeBlock = vi.fn().mockResolvedValue(true)
        const refreshDraftPicks = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
        const Probe = ({ tab }: { tab: TradeTabKey }) => {
            useTradeScreenRealtime({ leagueId: 'league-a', memberId: 'member-a', activeTab: tab,
                refreshTrades, refreshHistory, refreshTradeBlock, refreshDraftPicks })
            return null
        }
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(Probe, { tab: 'offers' })) })
            await act(async () => { mocks.subscribe.mock.calls[0][1].onStatus?.('SUBSCRIBED') })
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(refreshDraftPicks).not.toHaveBeenCalled()
            expect(refreshTrades).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { tab: 'block' })) })
            expect(refreshDraftPicks).toHaveBeenCalledTimes(1)
            expect(refreshTradeBlock).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { tab: 'offers' })) })
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(refreshDraftPicks).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { tab: 'picks' })) })
            expect(refreshDraftPicks).toHaveBeenCalledTimes(2)
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(refreshDraftPicks).toHaveBeenCalledTimes(2)
            expect(refreshTrades).toHaveBeenCalledTimes(1)
        } finally {
            await act(async () => { renderer.unmount() })
            vi.useRealTimers()
        }
    })

    it('recovers missed offers after socket resubscription while the browser stays online', async () => {
        const refreshTrades = vi.fn().mockResolvedValue(true)
        const refreshHistory = vi.fn()
        const refreshTradeBlock = vi.fn()
        const refreshDraftPicks = vi.fn()
        const Probe = ({ focused, leagueId }: { focused: boolean; leagueId: string }) => {
            useTradeScreenRealtime({ leagueId, memberId: 'member-a', activeTab: 'offers',
                online: true, focused, refreshTrades, refreshHistory, refreshTradeBlock, refreshDraftPicks })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { focused: true, leagueId: 'league-a' })) })
        const firstStatus = mocks.subscribe.mock.calls[0][1].onStatus
        await act(async () => { firstStatus?.('SUBSCRIBED') })
        refreshTrades.mockClear()
        await act(async () => { firstStatus?.('CHANNEL_ERROR'); firstStatus?.('SUBSCRIBED') })
        expect(refreshTrades).toHaveBeenCalledTimes(1)
        expect(refreshHistory).not.toHaveBeenCalled()
        expect(refreshTradeBlock).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { focused: false, leagueId: 'league-a' })) })
        await act(async () => { firstStatus?.('TIMED_OUT'); firstStatus?.('SUBSCRIBED') })
        expect(refreshTrades).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.update(React.createElement(Probe, { focused: true, leagueId: 'league-a' })) })
        expect(refreshTrades).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.update(React.createElement(Probe, { focused: true, leagueId: 'league-b' })) })
        await act(async () => { firstStatus?.('SUBSCRIBED') })
        expect(refreshTrades).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })

    it('retains failed reconnect work and retries only for the current visible owner', async () => {
        vi.useFakeTimers()
        const refreshTrades = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
        const refreshHistory = vi.fn()
        const refreshTradeBlock = vi.fn()
        const refreshDraftPicks = vi.fn()
        const Probe = ({ focused }: { focused: boolean }) => {
            useTradeScreenRealtime({ leagueId: 'league-a', memberId: 'member-a', activeTab: 'offers',
                online: true, focused, refreshTrades, refreshHistory, refreshTradeBlock, refreshDraftPicks })
            return null
        }
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(Probe, { focused: true })) })
            const status = mocks.subscribe.mock.calls[0][1].onStatus
            await act(async () => { status?.('SUBSCRIBED') })
            expect(refreshTrades).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { focused: false })) })
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(refreshTrades).toHaveBeenCalledTimes(1)
            await act(async () => { renderer.update(React.createElement(Probe, { focused: true })) })
            expect(refreshTrades).toHaveBeenCalledTimes(2)
            await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
            expect(refreshTrades).toHaveBeenCalledTimes(2)
        } finally {
            await act(async () => { renderer.unmount() })
            vi.useRealTimers()
        }
    })

    it('revalidates one feed after reconnect when visible and does not refetch idle hidden tabs', async () => {
        const refreshTrades = vi.fn()
        const refreshHistory = vi.fn()
        const refreshTradeBlock = vi.fn()
        const refreshDraftPicks = vi.fn()
        const Probe = ({ online, focused }: { online: boolean; focused: boolean }) => {
            useTradeScreenRealtime({ leagueId: 'league-a', memberId: 'member-a', activeTab: 'offers',
                online, focused, refreshTrades, refreshHistory, refreshTradeBlock, refreshDraftPicks })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { online: true, focused: false })) })
        await act(async () => { renderer.update(React.createElement(Probe, { online: false, focused: false })) })
        await act(async () => { renderer.update(React.createElement(Probe, { online: true, focused: false })) })
        expect(refreshTrades).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { online: true, focused: true })) })
        expect(refreshTrades).toHaveBeenCalledTimes(1)
        expect(refreshHistory).not.toHaveBeenCalled()
        expect(refreshTradeBlock).not.toHaveBeenCalled()
        expect(refreshDraftPicks).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

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
        await act(async () => { mocks.callbacks?.trades() })
        expect(refreshTrades).toHaveBeenCalledTimes(1)
        expect(refreshHistory).not.toHaveBeenCalled()

        await act(async () => { renderer.update(React.createElement(Probe, { tab: 'history' })) })
        expect(mocks.subscribe).toHaveBeenCalledTimes(1)
        expect(refreshHistory).toHaveBeenCalledTimes(1)
        await act(async () => { mocks.callbacks?.trades() })
        expect(refreshTrades).toHaveBeenCalledTimes(2)
        expect(refreshHistory).toHaveBeenCalledTimes(2)

        await act(async () => { renderer.unmount() })
        expect(mocks.dispose).toHaveBeenCalledTimes(1)
    })
})
