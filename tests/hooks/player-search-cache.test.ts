import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerSearch, useWeeklyAvailability } from '@/hooks/use-player-search'
import type { WeekDay } from '@/lib/lineup'

const mocks = vi.hoisted(() => ({
    addEventListener: vi.fn(),
    appStateListener: undefined as ((state: string) => void) | undefined,
    getCurrentWeekNumber: vi.fn(async () => 1),
    getStartedTeams: vi.fn(async () => new Set<string>()),
    getWeekDays: vi.fn<() => Promise<WeekDay[]>>(async () => []),
    searchPlayers: vi.fn(),
}))

vi.mock('@shopify/flash-list', () => ({}))
vi.mock('react-native', () => ({
    AppState: {
        currentState: 'active',
        addEventListener: mocks.addEventListener,
    },
}))
vi.mock('@/hooks/use-debounced-value', () => ({ useDebouncedValue: (value: unknown) => value }))
vi.mock('@/lib/players', () => ({ searchPlayers: mocks.searchPlayers }))
vi.mock('@/lib/lineup', () => ({
    getStartedTeams: mocks.getStartedTeams,
    getWeekDays: mocks.getWeekDays,
}))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: mocks.getCurrentWeekNumber }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2027) }))
vi.mock('@/lib/shared/dates', () => ({ todayET: vi.fn(() => '2026-10-20') }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn(() => null),
    writePersistentCache: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = (id: string) => ({ id, display_name: id })
const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.appStateListener = undefined
    mocks.addEventListener.mockImplementation((_event, listener) => {
        mocks.appStateListener = listener
        return { remove: vi.fn() }
    })
    mocks.getStartedTeams.mockResolvedValue(new Set())
    mocks.getWeekDays.mockResolvedValue([])
    mocks.getCurrentWeekNumber.mockResolvedValue(1)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0)
        return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('player search memory cache', () => {
    it('paints a stale cached page and revalidates it in the background', async () => {
        const owned = new Map()
        const waivers = new Set<string>()
        let resolveRevalidation!: (rows: ReturnType<typeof player>[]) => void
        const revalidation = new Promise<ReturnType<typeof player>[]>((resolve) => {
            resolveRevalidation = resolve
        })
        mocks.searchPlayers
            .mockResolvedValueOnce([player('all-old')])
            .mockResolvedValueOnce([player('guards')])
            .mockReturnValueOnce(revalidation)
        let latest!: ReturnType<typeof usePlayerSearch>
        const Probe = () => {
            latest = usePlayerSearch('league', owned, waivers, 'member')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        expect(latest.results.players.map((row) => row.id)).toEqual(['all-old'])

        await act(async () => { latest.position.setValue('PG'); await Promise.resolve() })
        expect(latest.results.players.map((row) => row.id)).toEqual(['guards'])
        vi.mocked(Date.now).mockReturnValue(1_031_000)

        await act(async () => { latest.position.setValue('ALL') })
        expect(latest.results.players.map((row) => row.id)).toEqual(['all-old'])
        await act(async () => { resolveRevalidation([player('all-new')]); await revalidation })
        expect(latest.results.players.map((row) => row.id)).toEqual(['all-new'])
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })
})

describe('weekly availability refresh ordering', () => {
    it('does not let an older overlapping refresh overwrite the latest snapshot', async () => {
        const first = deferred<Set<string>>()
        const second = deferred<Set<string>>()
        mocks.getStartedTeams
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
        mocks.getWeekDays.mockResolvedValue([{
            date: '2026-10-20',
            dayLabel: 'Tue',
            dateNum: 20,
            hasGames: true,
            isToday: true,
            playingTeams: ['LAL'],
        }])
        let latest!: ReturnType<typeof useWeeklyAvailability>
        const Probe = () => {
            latest = useWeeklyAvailability(true)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => {
            mocks.appStateListener?.('background')
            mocks.appStateListener?.('active')
            await Promise.resolve()
        })
        expect(mocks.getStartedTeams).toHaveBeenCalledTimes(2)

        await act(async () => { second.resolve(new Set(['LAL'])); await second.promise })
        expect(latest.gamesLeft.get('LAL')).toBeUndefined()
        await act(async () => { first.resolve(new Set()); await first.promise })
        expect(latest.gamesLeft.get('LAL')).toBeUndefined()
        await act(async () => { renderer.unmount() })
    })
})

describe('search response authority', () => {
    it.each(['support-first', 'search-first'])('keeps a failed refresh through equivalent support rerenders: %s', async (order) => {
        let owned = new Map()
        const waivers = new Set<string>()
        mocks.searchPlayers.mockReset().mockResolvedValueOnce([player('revision11')])
        let latest!: ReturnType<typeof usePlayerSearch>
        const Probe = () => { latest = usePlayerSearch('league', owned, waivers, 'member'); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let reject!: (e: Error) => void
        const failed = new Promise<ReturnType<typeof player>[]>((_resolve, no) => { reject = no })
        mocks.searchPlayers.mockReturnValueOnce(failed)
        await act(async () => { latest.results.retry() })
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(2)
        if (order === 'support-first') await act(async () => { owned = new Map(); renderer.update(React.createElement(Probe)) })
        await act(async () => { reject(new Error('search503')); await failed.catch(() => {}) })
        await act(async () => { owned = new Map(); renderer.update(React.createElement(Probe)) })
        expect(latest.results.error?.message).toBe('search503')
        expect(latest.results.isSnapshot).toBe(true)
        expect(latest.results.players.map(p => p.id)).toEqual(['revision11'])
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(2)
        mocks.searchPlayers.mockResolvedValueOnce([player('revision12')])
        await act(async () => { latest.results.retry() })
        expect(latest.results.error).toBeNull()
        expect(latest.results.isSnapshot).toBe(false)
        expect(latest.results.players.map(p => p.id)).toEqual(['revision12'])
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })
})

describe('search lifecycle ownership', () => {
    it('retains the same-query scroll position and fences hidden, old-query and old-account results', async () => {
        const owned = new Map()
        const waivers = new Set<string>()
        let focused = true
        let ownerId = 'first'
        let online = true
        mocks.searchPlayers.mockReset().mockResolvedValue([player('initial')])
        let latest!: ReturnType<typeof usePlayerSearch>
        const Probe = () => { latest = usePlayerSearch('league', owned, waivers, 'member', { focused, online, ownerId }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        const scroll = vi.fn()
        latest.results.listRef.current = { scrollToOffset: scroll } as unknown as NonNullable<typeof latest.results.listRef.current>
        const late = deferred<ReturnType<typeof player>[]>()
        mocks.searchPlayers.mockReturnValueOnce(late.promise)
        await act(async () => { latest.results.retry() })
        expect(scroll).not.toHaveBeenCalled()
        await act(async () => { focused = false; renderer.update(React.createElement(Probe)) })
        await act(async () => { late.resolve([player('hidden-old')]); await late.promise })
        expect(latest.results.players.map(p => p.id)).toEqual(['initial'])
        expect(latest.results.isSnapshot).toBe(true)
        const before = mocks.searchPlayers.mock.calls.length
        await act(async () => { online = false; renderer.update(React.createElement(Probe)); latest.results.retry() })
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(before)
        await act(async () => { online = true; focused = true; renderer.update(React.createElement(Probe)) })
        expect(mocks.searchPlayers).toHaveBeenCalledTimes(before + 1)
        const oldIdentity = deferred<ReturnType<typeof player>[]>()
        mocks.searchPlayers.mockReturnValueOnce(oldIdentity.promise)
        await act(async () => { latest.search.setQuery('old') })
        const next = deferred<ReturnType<typeof player>[]>()
        mocks.searchPlayers.mockReturnValueOnce(next.promise)
        await act(async () => { ownerId = 'second'; renderer.update(React.createElement(Probe)) })
        expect(latest.results.players).toEqual([])
        await act(async () => { oldIdentity.resolve([player('first-private')]); await oldIdentity.promise })
        expect(latest.results.players).toEqual([])
        await act(async () => { next.resolve([player('second-current')]); await next.promise })
        expect(latest.results.players.map(p => p.id)).toEqual(['second-current'])
        const unmounted = deferred<ReturnType<typeof player>[]>()
        mocks.searchPlayers.mockReturnValueOnce(unmounted.promise)
        await act(async () => { latest.results.retry(); renderer.unmount() })
        await act(async () => { unmounted.resolve([player('unmounted')]); await unmounted.promise })
    })
})
