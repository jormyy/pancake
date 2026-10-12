import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useLineupActions } from '@/hooks/use-lineup-actions'

const mocks = vi.hoisted(() => ({
    confirmAction: vi.fn(),
    showAlert: vi.fn(),
    showSuccess: vi.fn(),
    autoSetLineup: vi.fn(),
}))

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
vi.mock('@/lib/alert', () => ({
    getErrorMessage: (error: unknown) => String(error),
    confirmAction: mocks.confirmAction,
    showAlert: mocks.showAlert,
    showSuccess: mocks.showSuccess,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.clearAllMocks())

it('reports partial season optimization and exposes an explicit retry', async () => {
    mocks.autoSetLineup.mockResolvedValue({
        dates: 10,
        optimized: 7,
        skipped: 1,
        failed: 2,
        results: [
            { date: '2026-07-09', status: 'optimized' },
            { date: '2026-07-10', status: 'failed' },
            { date: '2026-07-11', status: 'skipped' },
            { date: '2026-07-12', status: 'failed' },
        ],
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

    expect(mocks.confirmAction).toHaveBeenCalledWith(
        'Lineup partly optimized',
        'Optimized 7 of 10 dates; 2 failed.',
        expect.any(Function),
        'Retry failed dates',
        false,
    )
    mocks.autoSetLineup.mockResolvedValueOnce({ dates: 2, optimized: 2, skipped: 0, failed: 0, results: [] })
    await act(async () => { await mocks.confirmAction.mock.calls[0][2]() })
    expect(mocks.autoSetLineup).toHaveBeenLastCalledWith(
        'member-1', 'league-1', 'season-1', 1, 2026, null, true,
        ['2026-07-10', '2026-07-12'],
    )
    await act(async () => { renderer.unmount() })
})


it('keeps optimization busy while the same owner refreshes action authority', async () => {
    let finish!: (value: null) => void
    mocks.autoSetLineup.mockImplementationOnce(() => new Promise<null>((resolve) => { finish = resolve }))
    let actions!: ReturnType<typeof useLineupActions>
    const owner = { memberId: 'member-1', leagueId: 'league-1', seasonId: 'season-1', weekNumber: 1, seasonYear: 2026 }
    const Probe = ({ authorized }: { authorized: boolean }) => {
        actions = useLineupActions({
            actionContext: authorized ? owner : null,
            actionOwner: owner,
            myLineup: { starters: [], bench: [] },
            league: { roster_size: 20 },
            selectedDate: '2026-07-09', startedTeams: new Set(),
            reloadLineup: vi.fn(async () => undefined),
        })
        return null
    }
    let renderer!: ReactTestRenderer
    let pending!: Promise<void>
    await act(async () => { renderer = create(React.createElement(Probe, { authorized: true })) })
    await act(async () => { pending = actions.doAutoSet(null, true) })
    expect(actions.autoSetting).toBe(true)
    await act(async () => { renderer.update(React.createElement(Probe, { authorized: false })) })
    expect(actions.autoSetting).toBe(true)
    await act(async () => { renderer.update(React.createElement(Probe, { authorized: true })) })
    expect(actions.autoSetting).toBe(true)
    await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
    expect(actions.selected).toBeNull()
    await act(async () => { finish(null); await pending })
    expect(actions.autoSetting).toBe(false)
    await act(async () => { renderer.unmount() })
})

it.each(['resolve', 'reject'] as const)('keeps a delayed old-date optimization out of the current editor on %s', async (outcome) => {
    let finish!: () => void
    mocks.autoSetLineup.mockImplementationOnce(() => new Promise<null>((resolve, reject) => {
        finish = () => outcome === 'resolve' ? resolve(null) : reject(new Error('old request failed'))
    }))
    let actions!: ReturnType<typeof useLineupActions>
    const reload = vi.fn(async () => undefined)
    const owner = { memberId: 'member-1', leagueId: 'league-1', seasonId: 'season-1', weekNumber: 1, seasonYear: 2026 }
    const Probe = ({ date }: { date: string }) => {
        actions = useLineupActions({
            actionContext: owner, myLineup: { starters: [], bench: [] },
            league: { roster_size: 20 }, selectedDate: date, startedTeams: new Set(), reloadLineup: reload,
        })
        return null
    }
    let renderer!: ReactTestRenderer
    let pending!: Promise<void>
    await act(async () => { renderer = create(React.createElement(Probe, { date: '2026-07-09' })) })
    const delayedEnableContinuation = actions.doAutoSet
    await act(async () => { renderer.update(React.createElement(Probe, { date: '2026-07-10' })) })
    await act(async () => { actions.setSelected({ kind: 'bench', index: 0 }) })
    try {
        await act(async () => { pending = delayedEnableContinuation(null, true) })
        expect(mocks.autoSetLineup).toHaveBeenCalledWith('member-1', 'league-1', 'season-1', 1, 2026, null, true, undefined)
        await act(async () => { finish(); await pending })
        expect(actions.autoSetting).toBe(false)
        expect(actions.selected).toEqual({ kind: 'bench', index: 0 })
        expect(reload).not.toHaveBeenCalled()
        expect(mocks.showAlert).not.toHaveBeenCalled()
        expect(mocks.showSuccess).not.toHaveBeenCalled()
    } finally {
        await act(async () => { renderer.unmount() })
    }
})

it('does not publish optimization feedback after its editor unmounts', async () => {
    mocks.autoSetLineup.mockResolvedValueOnce(null)
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = () => {
        actions = useLineupActions({
            actionContext: { memberId: 'member-1', leagueId: 'league-1', seasonId: 'season-1', weekNumber: 1, seasonYear: 2026 },
            myLineup: { starters: [], bench: [] }, league: { roster_size: 20 },
            selectedDate: '2026-07-09', startedTeams: new Set(), reloadLineup: vi.fn(async () => undefined),
        })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const delayedEnableContinuation = actions.doAutoSet
    await act(async () => { renderer.unmount() })
    await act(async () => { await delayedEnableContinuation(null, true) })
    expect(mocks.autoSetLineup).toHaveBeenCalledTimes(1)
    expect(mocks.showSuccess).not.toHaveBeenCalled()
    expect(mocks.showAlert).not.toHaveBeenCalled()
})

it('suppresses optimization feedback when the editor leaves during reload', async () => {
    mocks.autoSetLineup.mockResolvedValueOnce(null)
    let finishReload!: () => void
    const reload = vi.fn(() => new Promise<void>((resolve) => { finishReload = resolve }))
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = () => {
        actions = useLineupActions({
            actionContext: { memberId: 'member-1', leagueId: 'league-1', seasonId: 'season-1', weekNumber: 1, seasonYear: 2026 },
            myLineup: { starters: [], bench: [] }, league: { roster_size: 20 },
            selectedDate: '2026-07-09', startedTeams: new Set(), reloadLineup: reload,
        })
        return null
    }
    let renderer!: ReactTestRenderer
    let pending!: Promise<void>
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { pending = actions.doAutoSet(null, true) })
    expect(reload).toHaveBeenCalledTimes(1)
    await act(async () => { renderer.unmount() })
    await act(async () => { finishReload(); await pending })
    expect(mocks.showSuccess).not.toHaveBeenCalled()
})
