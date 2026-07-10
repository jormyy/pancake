import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useLineupActions } from '@/hooks/use-lineup-actions'

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    autoSetLineup: vi.fn(),
}))

vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }))
vi.mock('@/lib/lineup', () => ({
    autoSetLineup: mocks.autoSetLineup,
    planLineupMove: vi.fn(),
    setPlayerSlotMoves: vi.fn(),
}))
vi.mock('@/lib/roster', () => ({
    activateRosterPlayerWithLineup: vi.fn(),
    toggleIR: vi.fn(),
    toggleTaxi: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: vi.fn(() => '2026-07-09') }))
vi.mock('@/lib/alert', () => ({ getErrorMessage: (error: unknown) => String(error) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.clearAllMocks())

it('reports partial season optimization and exposes an explicit retry', async () => {
    mocks.autoSetLineup.mockResolvedValue({
        dates: 10,
        optimized: 7,
        skipped: 1,
        failed: 2,
        results: [],
    })
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = () => {
        actions = useLineupActions({
            actionContext: {
                memberId: 'member-1',
                leagueId: 'league-1',
                seasonId: 'season-1',
                weekNumber: 1,
                seasonYear: 2026,
            },
            myLineup: { starters: [], bench: [] },
            league: { roster_size: 20 },
            selectedDate: '2026-07-09',
            startedTeams: new Set(),
            reloadLineup: vi.fn(async () => undefined),
        })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })

    await act(async () => { await actions.doAutoSet(null, true) })

    expect(mocks.alert).toHaveBeenCalledWith(
        'Lineup partly optimized',
        'Optimized 7 of 10 dates; 2 failed.',
        expect.arrayContaining([expect.objectContaining({ text: 'Retry failed dates', onPress: expect.any(Function) })]),
    )
    await act(async () => { renderer.unmount() })
})
