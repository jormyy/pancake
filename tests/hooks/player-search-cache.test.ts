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
