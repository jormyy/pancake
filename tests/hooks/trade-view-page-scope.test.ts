import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTradeViewPage } from '@/hooks/use-trade-view-page'
import type { Trade } from '@/lib/trades'

const mocks = vi.hoisted(() => ({
    views: new Map<string, unknown>(),
    nextPage: null as null | ((value: unknown) => void),
}))

vi.mock('@/hooks/use-screen-view', () => ({
    useScreenView: (scope: { leagueId: string } | null) => {
        const data = scope ? mocks.views.get(scope.leagueId) : undefined
        return { data, loaded: data !== undefined, loading: false, refreshing: false, offline: false, error: null, refresh: async () => true }
    },
}))
vi.mock('@/lib/cache/screen-cache', () => ({
    readScreenView: () => new Promise(resolve => { mocks.nextPage = resolve }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trade = (id: string) => ({ id }) as Trade
const page = (ids: string[], hasMore: boolean) => ({ trades: ids.map(trade), nextCursor: hasMore ? { token: 'next' } : null, hasMore })

let latest!: ReturnType<typeof useTradeViewPage>
let renderer: ReactTestRenderer

function Feed({ leagueId }: { leagueId: string }) {
    latest = useTradeViewPage('member', leagueId, 'offers', true, true, 'account')
    return null
}

beforeEach(() => {
    mocks.views.clear()
    mocks.views.set('league-a', page(['a1'], true))
    mocks.views.set('league-b', page(['b1'], true))
})

afterEach(async () => { await act(async () => renderer?.unmount()) })

it('never appends league A trades after the feed moved to league B', async () => {
    await act(async () => { renderer = create(React.createElement(Feed, { leagueId: 'league-a' })) })
    let pending!: Promise<void>
    await act(async () => { pending = latest.loadMore() })
    await act(async () => { renderer.update(React.createElement(Feed, { leagueId: 'league-b' })) })
    await act(async () => { mocks.nextPage!(page(['a2'], false)); await pending })
    expect(latest.trades.map(item => item.id)).toEqual(['b1'])
    expect(latest.loadMoreError).toBeNull()
})

it('appends the next page for the same league', async () => {
    await act(async () => { renderer = create(React.createElement(Feed, { leagueId: 'league-a' })) })
    let pending!: Promise<void>
    await act(async () => { pending = latest.loadMore() })
    await act(async () => { mocks.nextPage!(page(['a2'], false)); await pending })
    expect(latest.trades.map(item => item.id)).toEqual(['a1', 'a2'])
    expect(latest.hasMore).toBe(false)
})
