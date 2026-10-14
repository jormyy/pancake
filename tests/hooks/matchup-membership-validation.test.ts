import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMatchupData } from '@/hooks/use-matchup-data'

const mocks = vi.hoisted(() => ({ getMyMatchup: vi.fn(), readPersistentCache: vi.fn(), writePersistentCache: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useFocusEffect: vi.fn() }))
vi.mock('@/lib/scoring', () => ({ getMyMatchup: mocks.getMyMatchup, getLeagueWeekMatchups: vi.fn(async () => []) }))
vi.mock('@/lib/lineup', () => ({ clampDateToWeek: (date: string) => date, getWeekDays: vi.fn(async () => []), getWeeklyLineup: vi.fn(async () => ({ starters: [], bench: [], ir: [], taxi: [] })) }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-14' }))
vi.mock('@/lib/shared/season', () => ({ invalidateSeasonCache: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ invalidateWeekNumberCache: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => mocks)
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/lib/realtime', () => ({ debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn(() => ({})) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
    mocks.readPersistentCache.mockReturnValue(undefined)
    mocks.getMyMatchup.mockResolvedValue(null)
})

describe('matchup membership validation', () => {
    it('does not read or persist an empty matchup for a cached unvalidated membership', async () => {
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = ({ validated }: { validated: boolean }) => {
            latest = useMatchupData({ id: 'member' }, { id: 'user' }, { id: 'league' }, validated)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { validated: false })) })
        await act(async () => { await latest.refresh() })
        expect(mocks.getMyMatchup).not.toHaveBeenCalled()
        expect(mocks.writePersistentCache).not.toHaveBeenCalled()
        expect(latest.emptyConfirmed).toBe(false)
        await act(async () => { renderer.update(React.createElement(Probe, { validated: true })) })
        await act(async () => { await latest.refresh() })
        expect(latest.emptyConfirmed).toBe(true)
        expect(mocks.writePersistentCache).toHaveBeenCalledWith('pancake:home-matchup:v1:league:member', expect.objectContaining({ matchup: null }))
        await act(async () => { renderer.unmount() })
    })

    it('does not treat a same-day null cache as a fresh server confirmation', async () => {
        mocks.readPersistentCache.mockReturnValue({ today: '2026-10-14', matchup: null })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member' }, { id: 'user' }, { id: 'league' }, true); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.emptyConfirmed).toBe(false)
        await act(async () => { await latest.refresh() })
        expect(latest.emptyConfirmed).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('shows a positive cached matchup before membership validation', async () => {
        mocks.readPersistentCache.mockReturnValue({ today: '2026-10-14', matchup: { id: 'cached' } })
        let latest!: ReturnType<typeof useMatchupData>
        const Probe = () => { latest = useMatchupData({ id: 'member' }, { id: 'user' }, { id: 'league' }, false); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.matchup?.id).toBe('cached')
        expect(latest.matchupLoading).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})
