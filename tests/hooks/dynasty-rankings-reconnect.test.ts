import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetainedPanel } from '@/components/ui/RetainedPanel'
import { notifyLeagueChange, setLeagueChangesConnected, leagueSnapshotRevision } from '@/lib/league-changes'
import { todayET } from '@/lib/shared/dates'
import { useDynastyRankings } from '@/hooks/use-dynasty-rankings'

const mocks = vi.hoisted(() => ({
    getCurrentSeason: vi.fn(),
    getDynastyDecisionInputs: vi.fn(),
    getUnmatchedRookieRankings: vi.fn(),
    readPersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
}))

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', StyleSheet: { create: (styles: unknown) => styles } }))
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
    setLeagueChangesConnected('league', true)
    notifyLeagueChange('league', { topic: 'catchup', scopes: null })
    mocks.readPersistentCache.mockReturnValue({ inputs: [decisionRow('saved')], unmatchedRookies: [], savedAt: Date.now(), seasonYear: 2026, revision: leagueSnapshotRevision('league', 'daily'), day: todayET() })
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
    it('reuses fresh rankings through repeated focus and visibility cycles', async () => {
        await mount()
        for (let cycle = 0; cycle < 3; cycle++) { await send('blur'); await send('focus') }
        for (let cycle = 0; cycle < 3; cycle++) { await visibility(true); await visibility(false) }
        expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
        expect(mocks.getUnmatchedRookieRankings).not.toHaveBeenCalled()
        expect(latest.players[0].displayName).toBe('Player saved')
    })
    it('refreshes stale rankings when focus returns without a visibility event', async () => {
        const now = Date.now()
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
        try {
            await mount()
            clock.mockReturnValue(now + 300_000)
            await send('blur'); await send('focus')
            expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
            expect(latest.players[0].displayName).toBe('Player new')
        } finally { clock.mockRestore() }
    })
    it('removes listeners when the screen is unmounted', async () => {
        await mount(); await act(async () => { renderer?.unmount() }); renderer = undefined
        await send('online'); await visibility(false)
        expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    })
})

it('ends a no-cache offline entry with a recovery message and reads once after reconnect', async () => {
    mocks.readPersistentCache.mockReturnValue(null)
    online = false
    await mount()
    expect(latest.loading).toBe(false)
    expect(latest.refreshing).toBe(false)
    expect(latest.players).toEqual([])
    expect(latest.error?.message).toBe('No saved rankings. Connect to load them.')
    expect(mocks.getCurrentSeason).not.toHaveBeenCalled()
    expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    online = true
    await send('online')
    expect(latest.error).toBeNull()
    expect(latest.loading).toBe(false)
    expect(latest.players[0].displayName).toBe('Player new')
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
})

it('keeps a saved offline view but clears it when the offline account and league change', async () => {
    const Scoped = ({ owner }: { owner: string }) => {
        latest = useDynastyRankings({ userId: owner, memberId: 'member-' + owner, leagueId: 'league-' + owner, scoringSettings, teamCount: 12 })
        return null
    }
    online = false
    await act(async () => { renderer = create(React.createElement(Scoped, { owner: 'first' })); await flush() })
    expect(latest.players[0].displayName).toBe('Player saved')
    expect(latest.loading).toBe(false)
    expect(latest.error).toBeNull()
    mocks.readPersistentCache.mockReturnValue(null)
    await act(async () => { renderer!.update(React.createElement(Scoped, { owner: 'second' })); await flush() })
    expect(latest.players).toEqual([])
    expect(latest.loading).toBe(false)
    expect(latest.error?.message).toBe('No saved rankings. Connect to load them.')
    expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    online = true
    await send('online')
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledExactlyOnceWith({leagueId: 'league-second', memberId: 'member-second', seasonYear: 2026, limit: 600})
    expect(latest.error).toBeNull()
})


it('defers the retained rankings source while its outer panel is hidden', async () => {
    const panel = (active: boolean) => React.createElement(RetainedPanel, { active }, React.createElement(Probe))
    mocks.readPersistentCache.mockReturnValue(null)
    await act(async () => { renderer = create(panel(false)); await flush() })
    const readsWhileHidden = mocks.getCurrentSeason.mock.calls.length
    await act(async () => { renderer!.update(panel(true)); await flush() })
    expect(readsWhileHidden).toBe(0)
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
    expect(latest.players[0].displayName).toBe('Player new')
})

it.each(['network', 'visibility'])('catches up before the stalled pre-%s source settles', async kind => {
    const old = deferred<ReturnType<typeof decisionRow>[]>()
    mocks.getDynastyDecisionInputs.mockReturnValueOnce(old.promise).mockResolvedValueOnce([decisionRow('new')])
    await mount()
    await send('online')
    if (kind === 'network') { online = false; await send('offline'); online = true; await send('online') }
    else { await visibility(true); await visibility(false) }
    const beforeOldSettles = latest.players[0].displayName
    const readsBeforeOldSettles = mocks.getDynastyDecisionInputs.mock.calls.length
    await act(async () => { old.resolve([decisionRow('old')]); await old.promise; await flush() })
    expect(beforeOldSettles).toBe('Player new')
    expect(readsBeforeOldSettles).toBe(2)
    expect(latest.players[0].displayName).toBe('Player new')
    expect(mocks.writePersistentCache.mock.calls.every(([, value]) => value.inputs[0].display_name !== 'Player old')).toBe(true)
})


it('keeps daily invalidation pending while hidden and does not reload rankings for live stats', async () => {
    await mount()
    await act(async () => { notifyLeagueChange('league', { topic: 'stat', scopes: null }); await flush() })
    expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    await visibility(true)
    await act(async () => { notifyLeagueChange('league', { topic: 'resources', scopes: null }); await flush() })
    expect(mocks.getDynastyDecisionInputs).not.toHaveBeenCalled()
    await visibility(false)
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
    expect(latest.players[0].displayName).toBe('Player new')
})

it('revalidates a persisted source snapshot when its authoritative baseline is unavailable', async () => {
    setLeagueChangesConnected('league', false)
    await mount()
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledOnce()
    expect(latest.players[0].displayName).toBe('Player new')
})

it('joins source changes during a held forced read into one current follow-up', async () => {
    const old = deferred<ReturnType<typeof decisionRow>[]>()
    mocks.getDynastyDecisionInputs.mockReturnValueOnce(old.promise).mockResolvedValue([decisionRow('corrected')])
    await mount()
    await send('online')
    await act(async () => {
        notifyLeagueChange('league', { topic: 'resources', scopes: null })
        notifyLeagueChange('league', { topic: 'resources', scopes: null })
        await flush()
    })
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledTimes(1)
    await act(async () => { old.resolve([decisionRow('old')]); await old.promise; await flush(); await flush() })
    expect(mocks.getDynastyDecisionInputs).toHaveBeenCalledTimes(2)
    expect(latest.players[0].displayName).toBe('Player corrected')
})
