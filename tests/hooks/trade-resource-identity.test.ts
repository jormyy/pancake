import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeBlock } from '@/hooks/use-trade-block'
import { useTradesFeed } from '@/hooks/use-trades-feed'
import type { Trade, TradeBlockItem } from '@/lib/trades'

const { getTradesForScreen, getTradeBlockItems, getRoster } = vi.hoisted(() => ({
    getTradesForScreen: vi.fn(),
    getTradeBlockItems: vi.fn(),
    getRoster: vi.fn(),
}))

vi.mock('@/lib/trades', () => ({
    addTradeBlockItem: vi.fn(),
    getTradeBlockItems,
    getTradesForScreen,
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
    it('clears old trades and rejects stale completion after an uncached identity switch', async () => {
        const first = deferred<Trade[]>()
        const second = deferred<Trade[]>()
        getTradesForScreen.mockImplementation((memberId: string) => memberId === 'member-a' ? first.promise : second.promise)
        let latest!: ReturnType<typeof useTradesFeed>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradesFeed(memberId, leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' })) })
        expect(latest.trades).toEqual([])
        await act(async () => { first.resolve([trade('stale')]); await first.promise })
        expect(latest.trades).toEqual([])
        await act(async () => { second.resolve([trade('current')]); await second.promise })
        expect(latest.trades.map((item) => item.id)).toEqual(['current'])
        renderer.unmount()
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
})
