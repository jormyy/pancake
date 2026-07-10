import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWeeklyAvailability } from '@/hooks/use-player-search'

const mocks = vi.hoisted(() => ({
    appStateListener: null as ((state: string) => void) | null,
    getStartedTeams: vi.fn(),
}))

vi.mock('react-native', () => ({
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
            mocks.appStateListener = listener
            return { remove: vi.fn() }
        }),
    },
}))
vi.mock('@/lib/players', () => ({ searchPlayers: vi.fn() }))
vi.mock('@/lib/lineup', () => ({
    getStartedTeams: mocks.getStartedTeams,
    getWeekDays: vi.fn(async () => [{ date: 'today', playingTeams: ['LAL'] }]),
}))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: vi.fn(async () => 1) }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2027 }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => 'today' }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: vi.fn(), writePersistentCache: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.appStateListener = null
})

describe('player-search weekly availability refresh', () => {
    it('removes a team from games-left when its game starts without remounting', async () => {
        vi.useFakeTimers()
        mocks.getStartedTeams.mockResolvedValueOnce(new Set()).mockResolvedValue(new Set(['LAL']))
        let gamesLeft = new Map<string, number>()
        const Probe = () => {
            gamesLeft = useWeeklyAvailability(true).gamesLeft
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve(); await Promise.resolve() })
        expect(gamesLeft.get('LAL')).toBe(1)

        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(gamesLeft.has('LAL')).toBe(false)

        mocks.appStateListener?.('background')
        mocks.appStateListener?.('active')
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        expect(mocks.getStartedTeams).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })
})
