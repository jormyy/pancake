import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import type { RosterLimits } from '@/lib/roster-capacity'
import { rosterPlayer } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({
    toggleIR: vi.fn(),
    dropPlayer: vi.fn(),
    dropAndAdd: vi.fn(),
    loadGate: vi.fn(),
    addOrRequestDrop: vi.fn(),
    resolveIR: vi.fn(),
    swap: vi.fn(),
    alert: vi.fn(),
    success: vi.fn(),
    claim: vi.fn(),
}))

vi.mock('@/lib/roster', () => ({ toggleIR: mocks.toggleIR, dropPlayer: mocks.dropPlayer, dropAndAddFreeAgent: mocks.dropAndAdd }))
vi.mock('@/lib/roster-add-flow', () => ({
    loadRosterAddGate: mocks.loadGate,
    addFreeAgentOrRequestDrop: mocks.addOrRequestDrop,
    resolveRosterAddIRConflict: mocks.resolveIR,
    swapHealthyIrWithInjured: mocks.swap,
}))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const incoming = { id: 'player-b', display_name: 'Player B' }
const changed = vi.fn()
let renderer: ReactTestRenderer | null = null
let latest: ReturnType<typeof useQuickAdd>

const Probe = ({ limits }: { limits: RosterLimits | null }) => {
    latest = useQuickAdd({ memberId: 'member', leagueId: 'league', limits, onChanged: changed, onClaimInstead: mocks.claim })
    return null
}

async function mount(limits: RosterLimits | null) {
    await act(async () => { renderer = create(React.createElement(Probe, { limits })) })
}

beforeEach(() => {
    vi.resetAllMocks()
    mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [], taxiExitIds: new Set() })
    mocks.addOrRequestDrop.mockResolvedValue({ status: 'added' })
})

afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

it('does not move a player to IR or add while limits are unknown', async () => {
    await mount(null)
    const drop = rosterPlayer({ id: 'drop' })
    await act(async () => latest.setDropPickerPlayer(incoming))
    await act(async () => latest.handleMoveToIRAndAdd(drop))

    expect(mocks.toggleIR).not.toHaveBeenCalled()
    expect(mocks.loadGate).not.toHaveBeenCalled()
    expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
})

it('moves a player to IR and adds once limits are known', async () => {
    await mount({ rosterSize: 20, irSlots: 2, taxiSlots: 0 })
    const drop = rosterPlayer({ id: 'drop' })
    await act(async () => latest.setDropPickerPlayer(incoming))
    await act(async () => latest.handleMoveToIRAndAdd(drop))

    expect(mocks.toggleIR).toHaveBeenCalledExactlyOnceWith('drop', true)
    expect(mocks.loadGate).toHaveBeenCalledOnce()
    expect(mocks.addOrRequestDrop).toHaveBeenCalledOnce()
})

it('uses limits that arrive after mount for a drop-and-add', async () => {
    await mount(null)
    const drop = rosterPlayer({ id: 'drop' })
    await act(async () => latest.setDropPickerPlayer(incoming))
    await act(async () => latest.handleDropAndAdd(drop))
    expect(mocks.loadGate).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()

    await act(async () => renderer!.update(React.createElement(Probe, { limits: { rosterSize: 20, irSlots: 2, taxiSlots: 0 } })))
    await act(async () => latest.handleDropAndAdd(drop))

    expect(mocks.loadGate).toHaveBeenCalledOnce()
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(incoming, { dropPlayerId: 'player-a', destination: 'active' })
})

it('stops a drop-and-add when limits go unknown', async () => {
    await mount({ rosterSize: 20, irSlots: 2, taxiSlots: 0 })
    const drop = rosterPlayer({ id: 'drop' })
    await act(async () => latest.setDropPickerPlayer(incoming))
    await act(async () => renderer!.update(React.createElement(Probe, { limits: null })))
    await act(async () => latest.handleDropAndAdd(drop))

    expect(mocks.loadGate).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
})
