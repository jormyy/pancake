import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useLineupActions } from '@/hooks/use-lineup-actions'
import { planLineupMove } from '@/lib/lineup/movePlan'

const mocks = vi.hoisted(() => ({
    confirmAction: vi.fn(),
    showAlert: vi.fn(),
    move: vi.fn(),
    plan: vi.fn(),
    activate: vi.fn(),
}))

vi.mock('@/lib/lineup', () => ({
    planLineupMove: mocks.plan,
    setPlayerSlotMoves: mocks.move,
}))
vi.mock('@/lib/roster', () => ({
    activateRosterPlayerWithLineup: mocks.activate,
    toggleIR: vi.fn(),
    toggleTaxi: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: vi.fn(() => '2026-07-09') }))
vi.mock('@/lib/alert', () => ({
    getErrorMessage: (error: unknown) => String(error),
    confirmAction: mocks.confirmAction,
    showAlert: mocks.showAlert,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.clearAllMocks())

it.each([
    ['move', 'read-failure'], ['activation', 'read-failure'],
    ['move', 'write-failure'], ['activation', 'write-failure'],
] as const)('%s distinguishes %s from a saved write', async (kind, outcome) => {
    const reload = vi.fn().mockRejectedValue(new Error('Lineup read offline'))
    mocks.move.mockResolvedValue(undefined)
    mocks.activate.mockResolvedValue(undefined)
    mocks.plan.mockImplementation(planLineupMove)
    const write = kind === 'activation' ? mocks.activate : mocks.move
    if (outcome === 'write-failure') write.mockRejectedValueOnce(new Error('Write refused'))
    const player = { rosterPlayerId: 'roster', playerId: 'player', displayName: 'Player', position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: null, nbaId: null }
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = () => {
        actions = useLineupActions({
            actionContext: { memberId: 'member', leagueId: 'league', seasonId: 'season', weekNumber: 1, seasonYear: 2026 },
            myLineup: React.useMemo(() => ({ starters: [{ slotType: 'PG', player: null }], bench: kind === 'activation' ? [] : [player], taxi: kind === 'activation' ? [player] : [] }), []),
            league: { roster_size: 20 }, selectedDate: '2026-07-09', startedTeams: new Set(), reloadLineup: reload,
        })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        await act(async () => { await actions.handleTap({ kind: kind === 'activation' ? 'taxi' : 'bench', index: 0 }) })
        await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
        if (kind === 'activation') await act(async () => { await mocks.confirmAction.mock.calls[0]?.[2]() })
        expect(write).toHaveBeenCalledOnce()
        expect(reload).toHaveBeenCalledTimes(outcome === 'read-failure' ? 1 : 0)
        if (outcome === 'read-failure') {
            expect(mocks.showAlert).toHaveBeenCalledWith('Lineup saved', expect.stringContaining('Refresh'), 'info')
            expect(mocks.showAlert.mock.calls.some(([title]) => title === 'Error')).toBe(false)
        } else {
            expect(mocks.showAlert).toHaveBeenCalledWith('Error', 'Write refused')
            expect(mocks.showAlert.mock.calls.some(([title]) => title === 'Lineup saved')).toBe(false)
        }
        expect(actions.saving).toBe(false)
    } finally { await act(async () => { renderer.unmount() }) }
})

it('clears an index selection when the lineup changes and keeps it when unchanged', async () => {
    const first = { starters: [{ slotType: 'PG', player: null }], bench: [] }
    const second = { ...first, bench: [] }
    const owner = { memberId: 'member', leagueId: 'league', seasonId: 'season', weekNumber: 1, seasonYear: 2026 }
    let actions!: ReturnType<typeof useLineupActions>
    const Probe = ({ lineup }: { lineup: typeof first }) => {
        actions = useLineupActions({ actionContext: owner, myLineup: lineup, league: { roster_size: 20 },
            selectedDate: '2026-07-09', startedTeams: new Set(), reloadLineup: async () => {} })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { lineup: first })) })
    try {
        await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
        await act(async () => { renderer.update(React.createElement(Probe, { lineup: first })) })
        expect(actions.selected).toEqual({ kind: 'starter', index: 0 })
        await act(async () => { renderer.update(React.createElement(Probe, { lineup: second })) })
        expect(actions.selected).toBeNull()
        await act(async () => { await actions.handleTap({ kind: 'bench', index: 0 }) })
        expect(mocks.plan).not.toHaveBeenCalled()
    } finally { await act(async () => { renderer.unmount() }) }
})

vi.mock('@/lib/timezone', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/timezone')>(), todayLeague: () => '2026-07-09' }))
