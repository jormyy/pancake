import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWeeklyAvailability } from '@/hooks/use-player-search'

const mocks = vi.hoisted(() => ({
    appStateListener: null as ((state: string) => void) | null,
    getWeekDays: vi.fn(),
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
    getWeekDays: mocks.getWeekDays,
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
    it('refreshes the playing-day filter schedule when the app becomes active', async () => {
        vi.useFakeTimers()
        mocks.getWeekDays.mockResolvedValueOnce([{ date: 'today', playingTeams: ['LAL'] }]).mockResolvedValue([{ date: 'today', playingTeams: ['BOS'] }])
        let weekDays: { playingTeams: string[] }[] = []
        const Probe = () => {
            weekDays = useWeeklyAvailability(true).weekDays
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve(); await Promise.resolve() })
        expect(weekDays[0]?.playingTeams).toEqual(['LAL'])

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
        expect(mocks.getWeekDays).toHaveBeenCalledTimes(1)

        mocks.appStateListener?.('background')
        mocks.appStateListener?.('active')
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        expect(weekDays[0]?.playingTeams).toEqual(['BOS'])
        expect(mocks.getWeekDays).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })
})
