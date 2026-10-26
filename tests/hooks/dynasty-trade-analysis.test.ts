import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import type { TradeEstimateQuote } from '@/lib/trade-estimates'

const mocks = vi.hoisted(() => ({ request: vi.fn(), change: null as null | ((value: { topic: string }) => void) }))
vi.mock('@/lib/trade-estimates', () => ({ requestTradeEstimate: mocks.request }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/contexts/panel-activity', () => ({ usePanelActivity: () => true }))
vi.mock('@/lib/league-changes', () => ({
    deferLeagueRefresh: (fn: () => void) => ({ trigger: fn, cancel: vi.fn() }),
    listenForLeagueChanges: (_league: string, fn: typeof mocks.change) => { mocks.change = fn; return () => { mocks.change = null } },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: Parameters<typeof useDynastyTradeAnalysis>[0] = {
    enabled: true, leagueId: 'league-a', memberId: 'member-a', scoringSettings: { points: 1 }, teams: 10, faabBudget: 100,
    participants: [], items: [{ kind: 'faab', fromMemberId: 'member-a', toMemberId: 'member-b', faabAmount: 10 }],
}
const quote = (id = 'quote-a', seasonYear = 2042): TradeEstimateQuote => ({
    id, seasonYear, modelVersion: 'test', inputVersion: id, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    analysis: { strategy: 'overall', teams: [], assets: [], sources: [], confidence: 0.5, missingInputs: [], assumptions: [] },
})
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof useDynastyTradeAnalysis>
const observations: ReturnType<typeof useDynastyTradeAnalysis>[] = []
function Probe({ input = base }: { input?: typeof base }) {
    latest = useDynastyTradeAnalysis(input)
    observations.push(latest)
    return null
}
async function render(input = base) {
    await act(async () => {
        if (renderer) renderer.update(React.createElement(Probe, { input }))
        else renderer = create(React.createElement(Probe, { input }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    observations.length = 0
    mocks.request.mockResolvedValue(quote())
})
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    renderer = undefined
    vi.useRealTimers()
})

it('hides the previous quote immediately when exact terms change or a new request fails', async () => {
    await render()
    expect(latest.quote?.id).toBe('quote-a')
    mocks.request.mockRejectedValueOnce(new Error('estimate unavailable'))
    observations.length = 0
    await render({ ...base, items: [{ ...base.items[0], kind: 'faab', faabAmount: 20 }] })
    expect(observations.every(result => result.quote === null)).toBe(true)
    expect(latest.error).toBe('estimate unavailable')
    expect(mocks.request).toHaveBeenLastCalledWith('member-a', [expect.objectContaining({ faabAmount: 20 })])
    await act(async () => { latest.retry() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest.error).toBeNull()
    expect(latest.quote?.id).toBe('quote-a')
    expect(mocks.request).toHaveBeenCalledTimes(3)
    expect(mocks.request).toHaveBeenLastCalledWith('member-a', [expect.objectContaining({ faabAmount: 20 })])
})

it('preserves explicit missing-data analysis instead of replacing it with zero-valued local assets', async () => {
    const limited = quote('limited')
    limited.analysis.missingInputs = ['dynasty rank']
    mocks.request.mockResolvedValue(limited)
    await render()
    expect(latest.analysis).toEqual(limited.analysis)
    expect(latest.quote?.id).toBe('limited')
})

it('uses the server active season and hides old league data on the first new render', async () => {
    await render()
    expect(latest.seasonYear).toBe(2042)
    const pending = deferred<TradeEstimateQuote>()
    mocks.request.mockReturnValueOnce(pending.promise)
    observations.length = 0
    await render({ ...base, leagueId: 'league-b', memberId: 'member-c' })
    expect(observations.every(result => result.analysis === null && result.seasonYear === null)).toBe(true)
    await act(async () => { pending.resolve(quote('quote-b', 2043)); await pending.promise })
    expect(latest.seasonYear).toBe(2043)
})

it('rejects an older response after an account or league switch', async () => {
    const pending = deferred<TradeEstimateQuote>()
    mocks.request.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(quote('new'))
    await render()
    await render({ ...base, leagueId: 'league-b', memberId: 'member-c' })
    await act(async () => { pending.resolve(quote('old')); await pending.promise })
    expect(latest.quote?.id).toBe('new')
})

it('refreshes source changes and expiry without changing selected terms', async () => {
    await render()
    mocks.request.mockResolvedValue(quote('refreshed'))
    await act(async () => { mocks.change?.({ topic: 'resources' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest.quote?.id).toBe('refreshed')
    await act(async () => { await vi.advanceTimersByTimeAsync(600000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mocks.request.mock.calls.every(call => JSON.stringify(call[1]) === JSON.stringify(base.items))).toBe(true)
    expect(mocks.request.mock.calls.length).toBeGreaterThanOrEqual(3)
})
