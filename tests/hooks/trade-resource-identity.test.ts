import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import type { Trade, TradeBlockItem, TradePage } from '@/lib/trades'

const { addTradeBlockItem, getTradeHistoryForScreen, getTradesForScreen, getTradeBlockItems, getRoster } = vi.hoisted(() => ({
    addTradeBlockItem: vi.fn(),
    getTradeHistoryForScreen: vi.fn(),
    getTradesForScreen: vi.fn(),
    getTradeBlockItems: vi.fn(),
    getRoster: vi.fn(),
}))

vi.mock('@/lib/trades', () => ({
    addTradeBlockItem,
    getTradeBlockItems,
    getTradesForScreen,
    getTradeHistoryForScreen,
    removeTradeBlockItem: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }))
vi.mock('@/lib/roster', () => ({ getRoster }))
vi.mock('@/lib/roster-stats', () => ({
    EMPTY_AVG_MAP: new Map(),
    EMPTY_STATS_MAP: new Map(),
    getRosterStatsMaps: vi.fn(async () => ({ avgMap: new Map(), avgStatsMap: new Map() })),
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn(() => null),
    writePersistentCache: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

const trade = (id: string): Trade => ({
    id,
    status: 'pending',
    proposedAt: '2026-07-09T10:00:00Z',
    acceptedAt: null,
    vetoWindowExpiresAt: null,
    completedAt: null,
    vetoedAt: null,
    expiresAt: null,
    notes: null,
    proposerMemberId: 'member-a',
    proposerTeamName: 'A',
    recipientMemberId: 'member-b',
    recipientTeamName: 'B',
    isMultiTeam: false,
    participants: [],
    parentTradeId: null,
    counteredFromTradeId: null,
    editedFromTradeId: null,
    replacedByTradeId: null,
    version: 1,
    proposerFaabAmount: 0,
    recipientFaabAmount: 0,
    myVetoed: false,
    routedItems: [],
})

beforeEach(() => {
    vi.clearAllMocks()
})

describe('trade resource identity', () => {
    it('paginates history only through the server-owned history feed', async () => {
        const initial = Array.from({ length: 40 }, (_, index) => trade(`history-${index}`))
        getTradeHistoryForScreen
            .mockResolvedValueOnce({ trades: initial, nextCursor: { token: '40' } })
            .mockResolvedValueOnce({ trades: [trade('history-40')], nextCursor: null })
        let latest!: ReturnType<typeof useTradeHistoryFeed>
        const Probe = () => { latest = useTradeHistoryFeed('member-a', 'league-a', true); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { await latest.loadMore() })

        expect(getTradesForScreen).not.toHaveBeenCalled()
        expect(getTradeHistoryForScreen.mock.calls.map((call) => call[3]?.token ?? null)).toEqual([null, '40'])
        expect(latest.trades.at(-1)?.id).toBe('history-40')
        await act(async () => { renderer.unmount() })
    })

    it('clears old trades and rejects stale completion after an uncached identity switch', async () => {
        const first = deferred<TradePage>()
        const second = deferred<TradePage>()
        getTradesForScreen.mockImplementation((memberId: string) => memberId === 'member-a' ? first.promise : second.promise)
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradesFeed(memberId, leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        await act(async () => {
            renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' }))
            expect(latest.trades).toEqual([])
        })
        expect(latest.trades).toEqual([])
        await act(async () => { first.resolve({ trades: [trade('stale')], nextCursor: null }); await first.promise })
        expect(latest.trades).toEqual([])
        await act(async () => { second.resolve({ trades: [trade('current')], nextCursor: null }); await second.promise })
        expect(latest.trades.map((item) => item.id)).toEqual(['current'])
        renderer.unmount()
    })

    it('cancels pagination on refresh and synchronously rejects duplicate page requests', async () => {
        const page = deferred<TradePage>()
        const refreshed = deferred<TradePage>()
        const initial = Array.from({ length: 40 }, (_, index) => trade(`initial-${index}`))
        getTradesForScreen.mockResolvedValueOnce({ trades: initial, nextCursor: { token: 'next' } })
            .mockReturnValueOnce(page.promise).mockReturnValueOnce(refreshed.promise)
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = () => {
            latest = useTradesFeed('member-a', 'league-a')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        let firstPage!: Promise<void>
        await act(async () => {
            firstPage = latest.loadMore()
            void latest.loadMore()
            await Promise.resolve()
        })
        expect(getTradesForScreen).toHaveBeenCalledTimes(2)
        let refresh!: Promise<void>
        await act(async () => { refresh = latest.refresh(); await Promise.resolve() })
        expect(latest.loadingMore).toBe(false)
        await act(async () => { page.resolve({ trades: [trade('stale-page')], nextCursor: null }); await firstPage })
        expect(latest.trades.some((item) => item.id === 'stale-page')).toBe(false)
        await act(async () => { refreshed.resolve({ trades: [trade('fresh')], nextCursor: null }); await refresh })
        expect(latest.trades.map((item) => item.id)).toEqual(['fresh'])
        await act(async () => { renderer.unmount() })
    })

    it('clears loaded trade-block state when both identities have no cache entry', async () => {
        const blockItem = {
            id: 'block-a', memberId: 'member-a', teamName: 'A', note: null,
            updatedAt: '2026-07-09T10:00:00Z',
            asset: { kind: 'faab', amount: 5 },
        } satisfies TradeBlockItem
        getTradeBlockItems.mockResolvedValue([blockItem])
        getRoster.mockResolvedValue([])
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradeBlock(memberId, leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        await act(async () => { await latest.refresh() })
        expect(latest.items.map((item) => item.id)).toEqual(['block-a'])
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' })) })
        expect(latest.items).toEqual([])
        expect(latest.busyId).toBeNull()
        expect(latest.error).toBeNull()
        renderer.unmount()
    })

    it('serializes trade-block mutations so later writes cannot invalidate earlier refreshes', async () => {
        const first = deferred<void>()
        const second = deferred<void>()
        addTradeBlockItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        getTradeBlockItems.mockResolvedValue([])
        getRoster.mockResolvedValue([])
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => {
            latest = useTradeBlock('member', 'league')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const player = (id: string) => ({
            id: `roster-${id}`,
            member_id: 'member',
            is_on_ir: false,
            is_on_taxi: false,
            acquired_via: 'draft',
            players: {
                id, display_name: id, nba_team: null, position: 'PG' as const,
                eligible_positions: ['PG'], injury_status: null, nba_id: null,
                nba_draft_number: null, years_exp: 1,
            },
        })
        let firstMutation!: Promise<void>
        let secondMutation!: Promise<void>
        await act(async () => {
            firstMutation = latest.addPlayer(player('one'))
            secondMutation = latest.addPlayer(player('two'))
            await Promise.resolve()
        })
        expect(addTradeBlockItem).toHaveBeenCalledTimes(1)
        await act(async () => { first.resolve(); await firstMutation })
        expect(addTradeBlockItem).toHaveBeenCalledTimes(2)
        await act(async () => { second.resolve(); await secondMutation })
        expect(latest.busyId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('does not refresh after an in-flight trade-block mutation outlives the owner', async () => {
        const mutation = deferred<void>()
        addTradeBlockItem.mockReturnValue(mutation.promise)
        getTradeBlockItems.mockResolvedValue([])
        getRoster.mockResolvedValue([])
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => {
            latest = useTradeBlock('member', 'league')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        const readsBeforeMutation = getTradeBlockItems.mock.calls.length
        const player = {
            id: 'roster-player', member_id: 'member', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft',
            players: { id: 'player', display_name: 'Player', nba_team: null, position: 'PG' as const,
                eligible_positions: ['PG'], injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 1 },
        }
        let pending!: Promise<void>
        await act(async () => { pending = latest.addPlayer(player); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { mutation.resolve(); await pending })
        expect(getTradeBlockItems).toHaveBeenCalledTimes(readsBeforeMutation)
    })
})
