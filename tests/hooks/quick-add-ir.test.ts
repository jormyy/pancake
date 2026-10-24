import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { playerRow, rosterPlayer } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), add: vi.fn(), move: vi.fn(), lock: vi.fn(), changed: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: vi.fn(), toggleIR: mocks.move }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: mocks.lock }))
vi.mock('@/lib/roster-add-flow', () => ({ loadRosterAddGate: mocks.gate, addFreeAgentOrRequestDrop: mocks.add, resolveRosterAddIRConflict: vi.fn() }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: vi.fn(), confirmAction: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useQuickAdd>
const injured = rosterPlayer()
injured.players.injury_status = 'Out'
const target = playerRow({ injury_status: 'Out' })
const Probe = ({ allowIR = true }: { allowIR?: boolean }) => {
    latest = useQuickAdd({ memberId: 'member', leagueId: 'league', irSlots: 1, allowIR, onChanged: mocks.changed })
    return null
}
beforeEach(async () => {
    vi.resetAllMocks()
    mocks.gate.mockResolvedValue({ roster: [injured], ineligible: [] })
    mocks.add.mockResolvedValue({ status: 'added' })
    mocks.lock.mockResolvedValue(null)
    await act(async () => { screen = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => screen.unmount()) })

it('adds an eligible free agent straight to IR without a drop', async () => {
    await act(async () => latest.handleAdd(target))
    expect(mocks.add).toHaveBeenCalledWith('member', 'league', target.id, [injured], true)
    expect(latest.dropPickerPlayer).toBeNull()
})
it.each(['healthy', 'full IR', 'offseason'])('uses active placement for %s', async reason => {
    if (reason === 'full IR') mocks.gate.mockResolvedValue({ roster: [rosterPlayer({ is_on_ir: true })], ineligible: [] })
    if (reason === 'offseason') await act(async () => screen.update(React.createElement(Probe, { allowIR: false })))
    await act(async () => latest.handleAdd(reason === 'healthy' ? playerRow() : target))
    expect(mocks.add.mock.calls[0][4]).toBe(false)
})
it('moves an Out player to IR and then adds the healthy free agent', async () => {
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [injured] })
    await act(async () => latest.handleAdd(playerRow()))
    expect(latest.irMoveCandidates).toEqual([injured])
    mocks.gate.mockResolvedValue({ roster: [rosterPlayer({ ...injured, is_on_ir: true })], ineligible: [] })
    await act(async () => latest.handleMoveToIRAndAdd(injured))
    expect(mocks.move).toHaveBeenCalledWith(injured.id, true)
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(latest.dropPickerPlayer).toBeNull()
})
it('keeps the player when the server rejects an IR move', async () => {
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [injured] })
    await act(async () => latest.handleAdd(playerRow()))
    mocks.move.mockRejectedValue({ code: 'PA007', message: 'Your IR slots are full (1 slots).' })
    await act(async () => latest.handleMoveToIRAndAdd(injured))
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.alert).toHaveBeenCalledWith('IR is full', 'Your IR slots are full (1 slots).')
    expect(latest.dropPickerPlayer).not.toBeNull()
})
it('prevents a duplicate move while the existing move waits', async () => {
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [injured] })
    await act(async () => latest.handleAdd(playerRow()))
    let finish!: () => void
    mocks.move.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = latest.handleMoveToIRAndAdd(injured) })
    await act(async () => latest.handleMoveToIRAndAdd(injured))
    expect(mocks.move).toHaveBeenCalledOnce()
    await act(async () => { finish(); await pending })
})
