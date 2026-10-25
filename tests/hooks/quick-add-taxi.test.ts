import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { playerRow, rosterPlayer } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), add: vi.fn(), success: vi.fn(), changed: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: vi.fn() }))
vi.mock('@/lib/roster-add-flow', () => ({ loadRosterAddGate: mocks.gate, addFreeAgentOrRequestDrop: mocks.add, resolveRosterAddIRConflict: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useQuickAdd>
const player = playerRow({ years_exp: 2, career_regular_season_games: 64 })
const Probe = ({ rosterSize = 2 }: { rosterSize?: number }) => {
    latest = useQuickAdd({ memberId: 'member', leagueId: 'league', taxiSlots: 1, rosterSize, onChanged: mocks.changed })
    return null
}
beforeEach(() => { vi.resetAllMocks(); mocks.gate.mockResolvedValue({ roster: [rosterPlayer()], ineligible: [], taxiExitIds: new Set() }); mocks.add.mockResolvedValue({ status: 'added' }) })
afterEach(async () => { await act(async () => screen?.unmount()) })
it.each([1, 2])('offers taxi before drops or alongside Add with active limit %s', async rosterSize => {
    await act(async () => { screen = create(React.createElement(Probe, { rosterSize })) })
    await act(async () => latest.handleAdd(player))
    expect(mocks.add).not.toHaveBeenCalled()
    expect(latest.dropPickerPlayer?.id).toBe(player.id)
    expect(latest.taxiAvailable).toBe(true)
    expect(latest.canAddActive).toBe(rosterSize === 2)
    await act(async () => latest.handleAddToTaxi())
    expect(mocks.add).toHaveBeenCalledWith('member', 'league', player.id, expect.any(Array), false, true)
    expect(mocks.success).toHaveBeenCalledWith('Added', `${player.display_name} added to taxi.`)
    expect(latest.dropPickerPlayer).toBeNull()
})
it.each(['exit', 'full taxi', 'unknown'])('omits taxi for %s', async reason => {
    mocks.gate.mockResolvedValue({ roster: reason === 'full taxi' ? [rosterPlayer({ is_on_taxi: true })] : [], ineligible: [], taxiExitIds: new Set(reason === 'exit' ? [player.id] : []) })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => latest.handleAdd(reason === 'unknown' ? playerRow({ years_exp: 1 }) : player))
    expect(latest.taxiAvailable).toBe(false)
    expect(mocks.add).toHaveBeenCalledOnce()
})
it('keeps automatic IR placement ahead of taxi', async () => {
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => latest.handleAdd({ ...player, injury_status: 'Out' }))
    expect(mocks.add).toHaveBeenCalledWith('member', 'league', player.id, expect.any(Array), true)
    expect(latest.dropPickerPlayer).toBeNull()
})


it('opens roster resolution for PA009 even when refreshed display data has no known problem', async () => {
    mocks.gate.mockResolvedValue({ roster: [], ineligible: [], taxiExitIds: new Set() })
    mocks.add.mockRejectedValue({ code: 'PA009', message: 'Server taxi problem' })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => latest.handleAdd(playerRow()))
    expect(latest.irModal?.serverMessage).toBe('Server taxi problem')
    expect(latest.dropPickerPlayer).toBeNull()
})

it('shows the server refusal when an accepted trade holds the last taxi slot', async () => {
    const message = 'Your taxi squad is full (1 slots). Accepted trades hold 1 taxi slot(s).'
    mocks.add.mockRejectedValue({ code: 'P0001', message })
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => latest.handleAdd(player))
    await act(async () => latest.handleAddToTaxi())
    expect(mocks.alert).toHaveBeenCalledWith('Error', message)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(latest.dropPickerPlayer?.id).toBe(player.id)
})
