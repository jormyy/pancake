import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePlayerSearch } from '@/hooks/use-player-search'

const mocks = vi.hoisted(() => ({
    searchPlayers: vi.fn(),
}))

vi.mock('@shopify/flash-list', () => ({}))
vi.mock('react-native', () => ({
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
}))
vi.mock('@/hooks/use-debounced-value', () => ({ useDebouncedValue: (value: unknown) => value }))
vi.mock('@/lib/players', () => ({ searchPlayers: mocks.searchPlayers }))
vi.mock('@/lib/lineup', () => ({
    getStartedTeams: vi.fn(async () => new Set()),
    getWeekDays: vi.fn(async () => []),
}))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: vi.fn(async () => 1) }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2027) }))
vi.mock('@/lib/shared/dates', () => ({ todayET: vi.fn(() => '2026-10-20') }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn(() => null),
    writePersistentCache: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = (id: string) => ({ id, display_name: id })

beforeEach(() => {
    vi.clearAllMocks()
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
