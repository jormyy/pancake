import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import { useTradeHistoryFeed } from '@/hooks/use-trade-history-feed'
import type { RosterStatsMaps } from '@/lib/roster-stats'
import type { Trade, TradeBlockItem, TradePage } from '@/lib/trades'

const { addTradeBlockItem, getRosterStatsMaps, getTradeHistoryForScreen, getTradesForScreen, getTradeBlockItems, getRoster } = vi.hoisted(() => ({
    addTradeBlockItem: vi.fn(),
    getRosterStatsMaps: vi.fn(),
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
    withTradeBlockStats: (items: TradeBlockItem[]) => items,
}))
vi.mock('@/lib/roster', () => ({ getRoster }))
vi.mock('@/lib/roster-stats', () => ({
    EMPTY_AVG_MAP: new Map(),
    EMPTY_STATS_MAP: new Map(),
    getRosterStatsMaps,
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

const rosterPlayer = (id: string) => ({
    id: `roster-${id}`,
    member_id: 'member',
    is_on_ir: false,
    is_on_taxi: false,
    acquired_via: 'draft',
    players: {
        id,
        display_name: id,
        nba_team: null,
        position: 'PG' as const,
        eligible_positions: ['PG'],
        injury_status: null,
        nba_id: null,
        nba_draft_number: null,
        years_exp: 1,
    },
})

beforeEach(() => {
    vi.clearAllMocks()
    getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('trade resource identity', () => {
    it('does not expose readiness from the previous member error', async () => {
        vi.mocked(readPersistentCache).mockReturnValue(null)
        getTradeBlockItems.mockRejectedValueOnce(new Error('previous member failed'))
        getRoster.mockResolvedValue([])
        let latest!: ReturnType<typeof useTradeBlock>
        const observations: { memberId: string; ready: boolean }[] = []
        const Probe = ({ memberId }: { memberId: string }) => {
            latest = useTradeBlock(memberId, 'league')
            observations.push({ memberId, ready: latest.displayReady })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a' })) })
        await act(async () => { await latest.refresh() })
        expect(latest.displayReady).toBe(true)
        await act(async () => renderer.update(React.createElement(Probe, { memberId: 'member-b' })))
        expect(observations.find((value) => value.memberId === 'member-b')).toEqual({ memberId: 'member-b', ready: false })
        await act(async () => renderer.unmount())
    })

    it('paginates history only through the server-owned history feed', async () => {
        const initial = Array.from({ length: 40 }, (_, index) => trade(`history-${index}`))
        getTradeHistoryForScreen
            .mockResolvedValueOnce({ trades: initial, nextCursor: { token: '40' }, hasMore: true })
            .mockResolvedValueOnce({ trades: [trade('history-40')], nextCursor: null, hasMore: false })
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
        await act(async () => { first.resolve({ trades: [trade('stale')], nextCursor: null, hasMore: false }); await first.promise })
        expect(latest.trades).toEqual([])
        await act(async () => { second.resolve({ trades: [trade('current')], nextCursor: null, hasMore: false }); await second.promise })
        expect(latest.trades.map((item) => item.id)).toEqual(['current'])
        renderer.unmount()
    })

    it('synchronously clears old history and rejects its stale completion after identity changes', async () => {
        const first = deferred<TradePage>()
        const second = deferred<TradePage>()
        getTradeHistoryForScreen.mockImplementation((memberId: string) =>
            memberId === 'member-a' ? first.promise : second.promise)
        let latest!: ReturnType<typeof useTradeHistoryFeed>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradeHistoryFeed(memberId, leagueId, true)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        await act(async () => {
            renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' }))
            expect(latest.trades).toEqual([])
        })
        await act(async () => { first.resolve({ trades: [trade('stale')], nextCursor: null, hasMore: false }); await first.promise })
        expect(latest.trades).toEqual([])
        await act(async () => { second.resolve({ trades: [trade('current')], nextCursor: null, hasMore: false }); await second.promise })
        expect(latest.trades.map((item) => item.id)).toEqual(['current'])
        await act(async () => { renderer.unmount() })
    })

    it('cancels pagination on refresh and synchronously rejects duplicate page requests', async () => {
        const page = deferred<TradePage>()
        const refreshed = deferred<TradePage>()
        const initial = Array.from({ length: 40 }, (_, index) => trade(`initial-${index}`))
        getTradesForScreen.mockResolvedValueOnce({ trades: initial, nextCursor: { token: 'next' }, hasMore: true })
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
        let refresh!: Promise<boolean>
        await act(async () => { refresh = latest.refresh(); await Promise.resolve() })
        expect(latest.loadingMore).toBe(false)
        await act(async () => { page.resolve({ trades: [trade('stale-page')], nextCursor: null, hasMore: false }); await firstPage })
        expect(latest.trades.some((item) => item.id === 'stale-page')).toBe(false)
        await act(async () => { refreshed.resolve({ trades: [trade('fresh')], nextCursor: null, hasMore: false }); await refresh })
        expect(latest.trades.map((item) => item.id)).toEqual(['fresh'])
        await act(async () => { renderer.unmount() })
    })

    it('continues from authoritative refs when hydration returns fewer trades than the page size', async () => {
        getTradesForScreen
            .mockResolvedValueOnce({ trades: [trade('visible')], nextCursor: { token: 'next' }, hasMore: true })
            .mockResolvedValueOnce({ trades: [trade('later')], nextCursor: null, hasMore: false })
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = () => { latest = useTradesFeed('member-a', 'league-a'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })

        expect(latest.hasMore).toBe(true)
        await act(async () => { await latest.loadMore() })

        expect(getTradesForScreen.mock.calls[1]?.[3]).toEqual({ token: 'next' })
        expect(latest.trades.map((item) => item.id)).toEqual(['visible', 'later'])
        await act(async () => { renderer.unmount() })
    })

    it('clears loaded trade-block state when both identities have no cache entry', async () => {
        const blockItem = {
            id: 'block-a', memberId: 'member-a', teamName: 'A', note: null,
            updatedAt: '2026-07-09T10:00:00Z',
            asset: { kind: 'pick', pickId: 'pick-a', seasonYear: 2027, round: 1, originalTeamName: 'A' },
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

    it('keeps authoritative trade-block listings and roster assets when optional averages fail', async () => {
        const blockItem = {
            id: 'block-a', memberId: 'member', teamName: 'A', note: null,
            updatedAt: '2026-07-09T10:00:00Z',
            asset: { kind: 'pick', pickId: 'pick-a', seasonYear: 2027, round: 1, originalTeamName: 'A' },
        } satisfies TradeBlockItem
        getTradeBlockItems.mockResolvedValue([blockItem])
        getRoster.mockResolvedValue([rosterPlayer('player-a')])
        getRosterStatsMaps.mockRejectedValue(new Error('averages offline'))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => { latest = useTradeBlock('member', 'league'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        await act(async () => { await latest.refresh() })

        expect(latest.items.map((item) => item.id)).toEqual(['block-a'])
        expect(latest.roster.map((item) => item.players.id)).toEqual(['player-a'])
        expect(latest.avgMap.size).toBe(0)
        expect(latest.avgStatsMap.size).toBe(0)
        expect(latest.error).toBeNull()
        expect(warn).toHaveBeenCalledWith('Could not load optional trade-block player averages.', expect.any(Error))
        await act(async () => { renderer.unmount() })
    })

    it('retains a successful trade-block mutation when its refresh cannot enrich averages', async () => {
        const player = rosterPlayer('player-a')
        addTradeBlockItem.mockResolvedValue(undefined)
        getTradeBlockItems.mockResolvedValue([])
        getRoster.mockResolvedValue([player])
        getRosterStatsMaps.mockRejectedValue(new Error('averages offline'))
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => { latest = useTradeBlock('member', 'league'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        await act(async () => { await latest.addPlayer(player) })

        expect(addTradeBlockItem).toHaveBeenCalledTimes(1)
        expect(latest.roster.map((item) => item.players.id)).toEqual(['player-a'])
        expect(latest.error).toBeNull()
        expect(latest.busyId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('settles a successful trade-block mutation while optional averages remain pending', async () => {
        const stats = deferred<RosterStatsMaps>()
        const player = rosterPlayer('player-a')
        addTradeBlockItem.mockResolvedValue(undefined)
        getTradeBlockItems.mockResolvedValue([])
        getRoster.mockResolvedValue([player])
        getRosterStatsMaps.mockReturnValue(stats.promise)
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = () => { latest = useTradeBlock('member', 'league'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        await act(async () => { await latest.addPlayer(player) })

        expect(addTradeBlockItem).toHaveBeenCalledTimes(1)
        expect(getRosterStatsMaps).toHaveBeenCalledWith(['player-a'], 'league')
        expect(latest.roster.map((entry) => entry.players.id)).toEqual(['player-a'])
        expect(latest.busyId).toBeNull()
        expect(latest.loading).toBe(false)
        expect(latest.error).toBeNull()
        expect(latest.displayReady).toBe(false)

        await act(async () => { await latest.addPlayer(rosterPlayer('player-b')) })
        expect(addTradeBlockItem).toHaveBeenCalledTimes(2)
        expect(latest.busyId).toBeNull()

        await act(async () => {
            stats.resolve({
                avgMap: new Map([['player-a', 42]]),
                avgStatsMap: new Map(),
            })
            await stats.promise
        })
        expect(latest.avgMap.get('player-a')).toBe(42)
        expect(latest.displayReady).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('discards stale optional trade-block averages after an identity change', async () => {
        const firstStats = deferred<RosterStatsMaps>()
        const secondStats = deferred<RosterStatsMaps>()
        getTradeBlockItems.mockResolvedValue([])
        getRoster.mockImplementation((_memberId: string, leagueId: string) =>
            Promise.resolve([rosterPlayer(`player-${leagueId}`)]))
        getRosterStatsMaps
            .mockReturnValueOnce(firstStats.promise)
            .mockReturnValueOnce(secondStats.promise)
        let latest!: ReturnType<typeof useTradeBlock>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useTradeBlock('member', leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'a' })) })

        await act(async () => { await latest.refresh() })
        expect(getRosterStatsMaps).toHaveBeenCalledWith(['player-a'], 'a')

        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'b' })) })
        await act(async () => { await latest.refresh() })
        expect(getRosterStatsMaps).toHaveBeenCalledWith(['player-b'], 'b')

        await act(async () => {
            firstStats.resolve({
                avgMap: new Map([['player-a', 99]]),
                avgStatsMap: new Map(),
            })
            await firstStats.promise
        })
        expect(latest.avgMap.has('player-a')).toBe(false)

        await act(async () => {
            secondStats.resolve({
                avgMap: new Map([['player-b', 7]]),
                avgStatsMap: new Map(),
            })
            await secondStats.promise
        })
        expect(latest.avgMap.get('player-b')).toBe(7)
        await act(async () => { renderer.unmount() })
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
        let firstMutation!: Promise<void>
        let secondMutation!: Promise<void>
        await act(async () => {
            firstMutation = latest.addPlayer(rosterPlayer('one'))
            secondMutation = latest.addPlayer(rosterPlayer('two'))
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


describe('trade reconnect authority', () => {
    it('retains offers without enabling decisions before a fresh reconnect response', async () => {
        getTradesForScreen.mockResolvedValueOnce({ trades: [trade('saved')], nextCursor: null, hasMore: false })
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = ({ online }: { online: boolean }) => {
            latest = useTradesFeed('member-a', 'league-a', online)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { online: true })) })
        expect(latest.isSnapshot).toBe(false)
        const old = deferred<TradePage>()
        getTradesForScreen.mockReturnValueOnce(old.promise)
        await act(async () => { void latest.refresh() })
        await act(async () => { renderer.update(React.createElement(Probe, { online: false })) })
        await act(async () => { renderer.update(React.createElement(Probe, { online: true })) })
        await act(async () => { old.resolve({ trades: [trade('late')], nextCursor: null, hasMore: false }) })
        expect(latest.trades.map((item) => item.id)).toEqual(['saved'])
        expect(latest.isSnapshot).toBe(true)
        getTradesForScreen.mockResolvedValueOnce({ trades: [], nextCursor: null, hasMore: false })
        await act(async () => { await latest.refresh() })
        expect(latest.trades).toEqual([])
        expect(latest.isSnapshot).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})

it('does not enrich a hidden block cache and waits for its fresh roster before loading averages', async () => {
    vi.mocked(readPersistentCache).mockReturnValue({
        items: [], roster: [rosterPlayer('cached-player')], avgEntries: [], avgStatsEntries: [],
    })
    getRoster.mockResolvedValue([rosterPlayer('fresh-player')])
    getTradeBlockItems.mockResolvedValue([])
    getRosterStatsMaps.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
    let latest!: ReturnType<typeof useTradeBlock>
    const Probe = ({ visible }: { visible: boolean }) => {
        latest = useTradeBlock('member', 'league', true, { visible })
        return null
    }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe, { visible: false })) })
        expect(getRosterStatsMaps).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { visible: true })) })
        expect(getRosterStatsMaps).not.toHaveBeenCalled()
        await act(async () => { await latest.refresh() })
        expect(getRosterStatsMaps).toHaveBeenCalledExactlyOnceWith(['fresh-player'], 'league')
        await act(async () => { renderer.update(React.createElement(Probe, { visible: false })) })
        expect(getRosterStatsMaps).toHaveBeenCalledTimes(1)
    } finally {
        await act(async () => { renderer.unmount() })
        vi.mocked(readPersistentCache).mockReturnValue(null)
    }
})


it.each(['offers', 'history'] as const)('keeps settled empty %s data available during refresh', async kind => {
    const read = kind === 'offers' ? getTradesForScreen : getTradeHistoryForScreen
    read.mockResolvedValue({ trades: [], nextCursor: null, hasMore: false })
    let latest!: ReturnType<typeof useTradesFeed> | ReturnType<typeof useTradeHistoryFeed>
    const Offers = () => { latest = useTradesFeed('member-empty', 'league-empty'); return null }
    const History = () => { latest = useTradeHistoryFeed('member-empty', 'league-empty', true); return null }
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(kind === 'offers' ? Offers : History)) })
    expect(latest.hasData).toBe(true)
    const pending = deferred<TradePage>()
    read.mockReturnValue(pending.promise)
    let request!: Promise<boolean>
    await act(async () => { request = latest.refresh() })
    expect(latest.loading).toBe(true)
    expect(latest.hasData).toBe(true)
    expect(latest.trades).toEqual([])
    await act(async () => { pending.resolve({ trades: [], nextCursor: null, hasMore: false }); await request })
    await act(async () => view.unmount())
})

it('marks the first history render pending before its effect starts the read', async () => {
    const pending = deferred<TradePage>()
    getTradeHistoryForScreen.mockReturnValue(pending.promise)
    const frames: { enabled: boolean; loading: boolean; hasData: boolean }[] = []
    const Probe = ({ enabled }: { enabled: boolean }) => {
        const result = useTradeHistoryFeed('member-history', 'league-history', enabled)
        frames.push({ enabled, loading: result.loading, hasData: result.hasData })
        return null
    }
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(Probe, { enabled: false })) })
    await act(async () => view.update(React.createElement(Probe, { enabled: true })))
    expect(frames.find(frame => frame.enabled)).toEqual({ enabled: true, loading: true, hasData: false })
    await act(async () => pending.resolve({ trades: [], nextCursor: null, hasMore: false }))
    await act(async () => view.unmount())
})

it('keeps a settled empty trade block available during refresh', async () => {
    vi.mocked(readPersistentCache).mockReturnValue(null)
    getTradeBlockItems.mockResolvedValue([])
    getRoster.mockResolvedValue([])
    let latest!: ReturnType<typeof useTradeBlock>
    const Probe = () => { latest = useTradeBlock('member-empty-block', 'league-empty-block'); return null }
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(Probe)) })
    await act(async () => { await latest.refresh() })
    expect(latest.hasData).toBe(true)
    const pending = deferred<TradeBlockItem[]>()
    getTradeBlockItems.mockReturnValue(pending.promise)
    let request!: Promise<boolean>
    await act(async () => { request = latest.refresh() })
    expect(latest.loading).toBe(true)
    expect(latest.hasData).toBe(true)
    await act(async () => { pending.resolve([]); await request })
    await act(async () => view.unmount())
})


it('retains trade-block averages until replacement statistics settle', async () => {
    vi.mocked(readPersistentCache).mockReturnValue(null)
    getTradeBlockItems.mockResolvedValue([])
    getRoster.mockResolvedValue([rosterPlayer('kept')])
    getRosterStatsMaps.mockResolvedValue({ avgMap: new Map([['kept', 14]]), avgStatsMap: new Map() })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let latest!: ReturnType<typeof useTradeBlock>
    const Probe = () => { latest = useTradeBlock('member-stats', 'league-stats'); return null }
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(Probe)) })
    await act(async () => { await latest.refresh() })
    expect(latest.avgMap.get('kept')).toBe(14)
    const pending = deferred<RosterStatsMaps>()
    getRosterStatsMaps.mockReturnValueOnce(pending.promise)
    await act(async () => { await latest.refresh() })
    expect(latest.avgMap.get('kept')).toBe(14)
    await act(async () => pending.resolve({ avgMap: new Map([['kept', 20]]), avgStatsMap: new Map() }))
    expect(latest.avgMap.get('kept')).toBe(20)
    getRosterStatsMaps.mockRejectedValueOnce(new Error('optional stats unavailable'))
    await act(async () => { await latest.refresh() })
    expect(latest.avgMap.get('kept')).toBe(20)
    expect(vi.mocked(writePersistentCache).mock.lastCall?.[1]).toEqual(expect.objectContaining({ avgEntries: [['kept', 20]] }))
    await act(async () => view.unmount())
    warning.mockRestore()
})


it.each(['history', 'duplicate'])('stops offer pagination when the next page adds only %s rows', async (page) => {
    const initial = trade('first')
    getTradesForScreen.mockResolvedValueOnce({ trades: [initial], nextCursor: { token: 'one' }, hasMore: true })
        .mockResolvedValueOnce({ trades: [page === 'history' ? { ...trade('old'), status: 'completed' } : initial], nextCursor: { token: 'two' }, hasMore: true })
    let latest!: ReturnType<typeof useTradesFeed>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useTradesFeed('member-a', 'league-a'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.hasMore).toBe(true)
    await act(async () => { await latest.loadMore() })
    expect(latest.hasMore).toBe(false)
    await act(async () => { await latest.loadMore() })
    expect(getTradesForScreen).toHaveBeenCalledTimes(2)
    await act(async () => { renderer.unmount() })
})

it('applies a saved roster plan to its own trade without reading another page', async () => {
    const incoming = { kind: 'player' as const, playerId: 'incoming', playerName: 'Incoming', position: 'PG', nbaTeam: 'LAL', fromMemberId: 'member-b', toMemberId: 'member-a', toTaxi: true }
    const first = { ...trade('first'), participants: [{ memberId: 'member-a', teamName: 'A', sortOrder: 0, isInitiator: true, acceptedAt: '2026-01-01', dropPlayerIds: [] }], routedItems: [incoming] }
    const other = trade('other')
    getTradesForScreen.mockResolvedValue({ trades: [first, other], nextCursor: null, hasMore: false })
    let latest!: ReturnType<typeof useTradesFeed>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useTradesFeed('member-a', 'league-a'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { latest.updateRosterPlan('first', { taxiPlayerIds: [], irPlayerIds: ['incoming'], dropPlayerIds: ['drop'] }) })
    expect(latest.trades[0].routedItems[0]).toMatchObject({ toTaxi: false, toIR: true })
    expect(latest.trades[0].participants[0].dropPlayerIds).toEqual(['drop'])
    expect(latest.trades[1]).toBe(other)
    expect(getTradesForScreen).toHaveBeenCalledOnce()
    await act(async () => { renderer.unmount() })
})


it('keeps inherited taxi placement when the saved plan has no optional taxi choices', async () => {
    const source = { ...trade('taxi'), routedItems: [{ kind: 'player' as const, playerId: 'inherited', playerName: 'Inherited', position: 'PG', nbaTeam: null,
        fromMemberId: 'member-b', toMemberId: 'member-a', fromTaxi: true, toTaxi: true }] }
    getTradesForScreen.mockResolvedValue({ trades: [source], nextCursor: null, hasMore: false })
    let latest!: ReturnType<typeof useTradesFeed>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useTradesFeed('member-a', 'league-a'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { latest.updateRosterPlan('taxi', { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }) })
    expect(latest.trades[0].routedItems[0]).toMatchObject({ toTaxi: true, toIR: false })
    await act(async () => { renderer.unmount() })
})


it.each(['empty', 'history'])('does not auto-page a first page with only %s results', async (page) => {
    getTradesForScreen.mockResolvedValue({ trades: page === 'history' ? [{ ...trade('old'), status: 'completed' }] : [], nextCursor: { token: 'next' }, hasMore: true })
    let latest!: ReturnType<typeof useTradesFeed>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useTradesFeed('member-a', 'league-a'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(latest.hasMore).toBe(false)
    await act(async () => { await latest.loadMore() })
    expect(getTradesForScreen).toHaveBeenCalledOnce()
    await act(async () => { renderer.unmount() })
})
