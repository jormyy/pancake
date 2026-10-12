import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDynastyRankings } from '@/hooks/use-dynasty-rankings'

const mocks = vi.hoisted(() => ({
    getCurrentSeason: vi.fn(),
    getDynastyDecisionInputs: vi.fn(),
    getUnmatchedRookieRankings: vi.fn(),
    readPersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
}))

vi.mock('@react-navigation/native', async () => {
    const { useEffect } = await import('react')
    return { useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]) }
})
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: mocks.getCurrentSeason,
    currentSeasonYear: () => 2026,
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: mocks.readPersistentCache,
    writePersistentCache: mocks.writePersistentCache,
}))
vi.mock('@/lib/dynasty-decisions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/dynasty-decisions')>()
    return {
        ...actual,
        getDynastyDecisionInputs: mocks.getDynastyDecisionInputs,
        getUnmatchedRookieRankings: mocks.getUnmatchedRookieRankings,
    }
})
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

const scoringSettings = { points: 1 }
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const decisionRow = (leagueId: string, overrides: Record<string, unknown> = {}) => ({
    player_id: `player-${leagueId}`, display_name: `Player ${leagueId}`, age: 24,
    five_year_rank: 8, rank_change: 1, injury_status: null, avg_fantasy_points: 42,
    projection_fantasy_points: 44, years_exp: 3, ranking_source: 'rankings',
    ranking_fetched_at: null, projection_source: 'projections', projection_fetched_at: null,
    nba_team: 'LAL', position: 'G', eligible_positions: ['G'], games_played: 50,
    avg_three_pointers_made: 2, avg_points: 20, avg_rebounds: 5, avg_assists: 5,
    avg_steals: 1, avg_blocks: 1, avg_turnovers: 2, headshot_url: null, nba_id: null,
    three_year_rank: null, rookie_rank: null,
    ...overrides,
})

beforeEach(() => {
    vi.clearAllMocks()
    mocks.readPersistentCache.mockReturnValue(null)
    mocks.getUnmatchedRookieRankings.mockResolvedValue([])
})


let events: EventTarget
let doc: EventTarget
let hidden = false
let online = true
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof useDynastyRankings>
const Probe = () => {
    latest = useDynastyRankings({ userId: 'user', memberId: 'member', leagueId: 'league', scoringSettings, teamCount: 12 })
    return null
}
const send = async (name: string) => { await act(async () => { events.dispatchEvent(new Event(name)); await flush() }) }
const visibility = async (value: boolean) => { hidden = value; await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); await flush() }) }
const mount = async () => { await act(async () => { renderer = create(React.createElement(Probe)); await flush() }) }
beforeEach(() => {
    hidden = false; online = true; events = new EventTarget(); doc = new EventTarget()
    Object.defineProperty(doc, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('window', events); vi.stubGlobal('document', doc)
    vi.stubGlobal('navigator', { get onLine() { return online } })
    mocks.getCurrentSeason.mockResolvedValue({ seasonYear: 2026 })
    mocks.readPersistentCache.mockReturnValue({ inputs: [decisionRow('saved')], unmatchedRookies: [], savedAt: Date.now(), seasonYear: 2026 })
    mocks.getDynastyDecisionInputs.mockResolvedValue([decisionRow('new')])
})
afterEach(async () => { await act(async () => { renderer?.unmount() }); renderer = undefined; vi.unstubAllGlobals() })
describe('Dynasty focused source revalidation', () => {
    it('bypasses a recent source snapshot on reconnect and preserves the query', async () => {
        await mount(); expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
        await act(async () => { latest.setQuery('Player'); await flush() })
        await send('online')
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
        expect(latest.players[0].displayName).toBe('Player new')
        expect(latest.query).toBe('Player')
    })
    it('defers hidden network events to one foreground read', async () => {
        await mount(); await visibility(true); await send('online'); await send('online'); await send('focus')
        expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
        await visibility(false)
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
    })
    it('joins concurrent foreground and network events without dropping saved rows', async () => {
        const pending = deferred<ReturnType<typeof decisionRow>[]>()
        mocks.getDynastyDecisionInputs.mockReturnValue(pending.promise)
        await mount(); await send('online'); await send('online'); await send('focus'); await visibility(false)
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
        expect(latest.players[0].displayName).toBe('Player saved')
        await act(async () => { pending.resolve([decisionRow('new')]); await pending.promise; await flush() })
        expect(latest.players[0].displayName).toBe('Player new')
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
    })
    it('fences a pre-disconnect response and reads once for the new network epoch', async () => {
        const pending = deferred<ReturnType<typeof decisionRow>[]>()
        mocks.getDynastyDecisionInputs.mockReturnValueOnce(pending.promise).mockResolvedValue([decisionRow('new')])
        await mount(); await send('online'); online = false; await send('offline'); online = true; await send('online'); await send('online')
        await act(async () => { pending.resolve([decisionRow('old')]); await pending.promise; await flush(); await flush() })
        expect(latest.players[0].displayName).toBe('Player new')
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledTimes(2)
        expect(mocks.writePersistentCache.mock.calls.every(([, value]) => value.inputs[0].display_name !== 'Player old')).toBe(true)
    })
    it('keeps saved rows and the error after failure, then retries on focus', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            mocks.getDynastyDecisionInputs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([decisionRow('new')])
            await mount(); await send('online')
            expect(latest.error?.message).toBe('503'); expect(latest.players[0].displayName).toBe('Player saved')
            await send('focus'); expect(latest.error).toBeNull(); expect(latest.players[0].displayName).toBe('Player new')
            expect(log.mock.calls.filter(([cause]) => cause instanceof Error && cause.message === '503')).toHaveLength(1)
        } finally { log.mockRestore() }
    })
    it('revalidates when window focus returns without a visibility event', async () => {
        await mount(); await send('blur'); await send('focus')
        expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
        expect(latest.players[0].displayName).toBe('Player new')
    })
    it('removes listeners when the screen is unmounted', async () => {
        await mount(); await act(async () => { renderer?.unmount() }); renderer = undefined
        await send('online'); await visibility(false)
        expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    })
})
