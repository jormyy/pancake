import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLineupActions } from '@/hooks/use-lineup-actions'

const mocks = vi.hoisted(() => ({ activate: vi.fn(), move: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/lineup', async () => ({ planLineupMove: (await import('@/lib/lineup/movePlan')).planLineupMove, setPlayerSlotMoves: mocks.move }))
vi.mock('@/lib/roster', () => ({ activateRosterPlayerWithLineup: mocks.activate, toggleIR: vi.fn() }))
vi.mock('@/lib/alert', () => ({ confirmAction: mocks.confirm, showAlert: vi.fn(), showSuccess: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-24' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = (id: string) => ({ rosterPlayerId: id, playerId: `player-${id}`, displayName: id,
    position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: 'Out', nbaId: null })
let screen: ReactTestRenderer
let actions: ReturnType<typeof useLineupActions>
const LIMITS = { roster_size: 1, ir_slots: 2, taxi_slots: 1 }
const Probe = ({ source = 'taxi', full = false, date = '2026-10-24', league = LIMITS }: { source?: 'ir' | 'taxi'; full?: boolean; date?: string; league?: { roster_size?: number; ir_slots?: number; taxi_slots?: number } | null }) => {
    const lineup = React.useMemo(() => ({ starters: [{ slotType: 'PG', player: null }],
        bench: full ? [player('Active')] : [], ir: source === 'ir' ? [player('Reserve')] : [],
        taxi: source === 'taxi' ? [player('Reserve')] : [] }), [source, full])
    actions = useLineupActions({ actionContext: { memberId: 'member', leagueId: 'league', seasonId: 'season', weekNumber: 1, seasonYear: 2026 },
        myLineup: lineup, league, selectedDate: date, startedTeams: new Set(), reloadLineup: async () => {} })
    return null
}
beforeEach(() => { vi.clearAllMocks(); mocks.activate.mockResolvedValue(undefined) })
afterEach(async () => { await act(async () => screen?.unmount()) })
const chooseActivation = async (source: 'ir' | 'taxi') => {
    await act(async () => { await actions.handleTap({ kind: source, index: 0 }) })
    await act(async () => { await actions.handleTap({ kind: 'starter', index: 0 }) })
}

it('asks before a taxi activation and writes only after confirmation', async () => {
    await act(async () => { screen = create(React.createElement(Probe)) })
    await chooseActivation('taxi')
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.move).not.toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledWith('Activate from Taxi?', expect.stringContaining('cannot return to your team’s taxi'), expect.any(Function), 'Confirm', true)
    await act(async () => mocks.confirm.mock.calls[0][2]())
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ activateRosterPlayerId: 'Reserve', activateSource: 'taxi', slotType: 'PG' }))
})

it.each(['ir', 'taxi'] as const)('asks before dropping for a full %s activation', async source => {
    await act(async () => { screen = create(React.createElement(Probe, { source, full: true })) })
    await chooseActivation(source)
    expect(actions.activationOverflowPending).toEqual({ rosterPlayerId: 'Reserve', source, slotType: 'PG', limits: { rosterSize: 1, irSlots: 2, taxiSlots: 1 } })
    await act(async () => { await actions.handleOverflowDrop('Active') })
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.move).not.toHaveBeenCalled()
    expect(mocks.confirm).toHaveBeenCalledWith('Drop Active?', expect.stringContaining('Drop Active to activate Reserve?'), expect.any(Function), 'Drop and activate', true)
    const message = mocks.confirm.mock.calls[0][1]
    if (source === 'taxi') expect(message).toContain('cannot return to your team’s taxi')
    await act(async () => mocks.confirm.mock.calls[0][2]())
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ activateRosterPlayerId: 'Reserve', activateSource: source, freeRosterPlayerId: 'Active', freeAction: 'drop' }))
    expect(actions.activationOverflowPending).toBeNull()
})

it.each([false, true])('ignores a confirmation after the lineup date changes with overflow %s', async full => {
    await act(async () => { screen = create(React.createElement(Probe, { full })) })
    await chooseActivation('taxi')
    if (full) await act(async () => { await actions.handleOverflowDrop('Active') })
    expect(mocks.confirm).toHaveBeenCalledOnce()
    await act(async () => screen.update(React.createElement(Probe, { full, date: '2026-10-25' })))
    await act(async () => mocks.confirm.mock.calls[0][2]())
    expect(mocks.activate).not.toHaveBeenCalled()
})

const synthetic = 'synthetic roster: '
const staleLimits = [['changed', { roster_size: 2, ir_slots: 2, taxi_slots: 1 }, 'Roster settings changed'], ['missing', null, 'Roster settings loading']] as const

it.each(staleLimits)(`${synthetic}drops a confirmed taxi activation when limits are %s before the write`, async (_label, league, title) => {
    const { showAlert } = await import('@/lib/alert')
    await act(async () => { screen = create(React.createElement(Probe)) })
    await chooseActivation('taxi')
    await act(async () => screen.update(React.createElement(Probe, { league })))
    await act(async () => mocks.confirm.mock.calls[0][2]())
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(showAlert).toHaveBeenCalledWith(title, expect.any(String))
})

it.each(staleLimits.flatMap(([label, league, title]) => (['ir', 'taxi'] as const).map(source => [source, label, league, title] as const)))(
    `${synthetic}clears a full %s activation choice when limits are %s`, async (source, _label, league, title) => {
        const { showAlert } = await import('@/lib/alert')
        await act(async () => { screen = create(React.createElement(Probe, { source, full: true })) })
        await chooseActivation(source)
        await act(async () => screen.update(React.createElement(Probe, { source, full: true, league })))
        await act(async () => { await actions.handleOverflowDrop('Active') })
        expect(mocks.confirm).not.toHaveBeenCalled()
        expect(actions.activationOverflowPending).toBeNull()
        expect(showAlert).toHaveBeenCalledWith(title, expect.any(String))
    })

it.each(staleLimits.flatMap(([label, league, title]) => (['ir', 'taxi'] as const).map(source => [source, label, league, title] as const)))(
    `${synthetic}writes nothing when %s limits are %s inside the drop confirmation`, async (source, _label, league, title) => {
        const { showAlert } = await import('@/lib/alert')
        await act(async () => { screen = create(React.createElement(Probe, { source, full: true })) })
        await chooseActivation(source)
        await act(async () => { await actions.handleOverflowDrop('Active') })
        await act(async () => screen.update(React.createElement(Probe, { source, full: true, league })))
        await act(async () => mocks.confirm.mock.calls[0][2]())
        expect(mocks.activate).not.toHaveBeenCalled()
        expect(actions.activationOverflowPending).toBeNull()
        expect(showAlert).toHaveBeenCalledWith(title, expect.any(String))
    })

it(`${synthetic}still writes a confirmed full activation once when limits are unchanged`, async () => {
    await act(async () => { screen = create(React.createElement(Probe, { full: true })) })
    await chooseActivation('taxi')
    await act(async () => { await actions.handleOverflowDrop('Active') })
    await act(async () => screen.update(React.createElement(Probe, { full: true, league: { ...LIMITS } })))
    await act(async () => mocks.confirm.mock.calls[0][2]())
    expect(mocks.activate).toHaveBeenCalledOnce()
})

