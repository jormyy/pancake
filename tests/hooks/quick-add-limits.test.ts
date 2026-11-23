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

const Probe = ({ limits, memberId = 'member', leagueId = 'league' }: { limits: RosterLimits | null; memberId?: string; leagueId?: string }) => {
    latest = useQuickAdd({ memberId, leagueId, limits, onChanged: changed, onClaimInstead: mocks.claim })
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

const LIMITS = { rosterSize: 20, irSlots: 2, taxiSlots: 0 }

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

it.each([
    [null, 'Roster settings loading'],
    [{ ...LIMITS, rosterSize: 21 }, 'Roster settings changed'],
] as const)('does not add when limits become %o while the roster read is pending', async (next, title) => {
    await mount(LIMITS)
    const gate = deferred<{ roster: never[]; ineligible: never[]; taxiExitIds: Set<string> }>()
    mocks.loadGate.mockReturnValueOnce(gate.promise)
    await act(async () => latest.setDropPickerPlayer(incoming))
    let placing!: Promise<void>
    await act(async () => { placing = latest.handleAddActive() })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: next })))
    await act(async () => { gate.resolve({ roster: [], ineligible: [], taxiExitIds: new Set() }); await placing })

    expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith(title, expect.any(String))
})

it('adds once when limits stay the same while the roster read is pending', async () => {
    await mount(LIMITS)
    const gate = deferred<{ roster: never[]; ineligible: never[]; taxiExitIds: Set<string> }>()
    mocks.loadGate.mockReturnValueOnce(gate.promise)
    await act(async () => latest.setDropPickerPlayer(incoming))
    let placing!: Promise<void>
    await act(async () => { placing = latest.handleAddActive() })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: { ...LIMITS } })))
    await act(async () => { gate.resolve({ roster: [], ineligible: [], taxiExitIds: new Set() }); await placing })

    expect(mocks.addOrRequestDrop).toHaveBeenCalledOnce()
})

it('does not hand off a drop-and-add when limits disappear while the roster read is pending', async () => {
    await mount(LIMITS)
    const gate = deferred<{ roster: never[]; ineligible: never[]; taxiExitIds: Set<string> }>()
    mocks.loadGate.mockReturnValueOnce(gate.promise)
    await act(async () => latest.setDropPickerPlayer(incoming))
    let dropping!: Promise<void>
    await act(async () => { dropping = latest.handleDropAndAdd(rosterPlayer({ id: 'drop' })) })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: null })))
    await act(async () => { gate.resolve({ roster: [], ineligible: [], taxiExitIds: new Set() }); await dropping })

    expect(mocks.claim).not.toHaveBeenCalled()
})

function openResolution() {
    const injured = rosterPlayer({ id: 'injured', is_on_ir: true })
    latest.setIrModal({ ineligible: [injured], roster: [injured], pendingPlayer: incoming, action: 'add', limits: LIMITS })
    return injured
}

it('drops exactly once from an open resolution modal after limits disappear, then stops', async () => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: null })))
    const drop = deferred<void>()
    mocks.dropPlayer.mockReturnValueOnce(drop.promise)
    let first!: Promise<void>
    await act(async () => { first = latest.handleResolutionDrop(injured); void latest.handleResolutionDrop(injured) })
    await act(async () => { drop.resolve(); await first })

    expect(mocks.dropPlayer).toHaveBeenCalledExactlyOnceWith('injured')
    expect(mocks.loadGate).not.toHaveBeenCalled()
    expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
    expect(latest.irModal).toBeNull()
    expect(changed).toHaveBeenCalledOnce()
    expect(mocks.alert).toHaveBeenCalledWith('Roster settings loading', expect.any(String))
})

it('stops the pickup when limits change while a resolution drop is pending', async () => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    const drop = deferred<void>()
    mocks.dropPlayer.mockReturnValueOnce(drop.promise)
    let pending!: Promise<void>
    await act(async () => { pending = latest.handleResolutionDrop(injured) })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: { ...LIMITS, rosterSize: 21 } })))
    await act(async () => { drop.resolve(); await pending })

    expect(mocks.dropPlayer).toHaveBeenCalledOnce()
    expect(mocks.loadGate).not.toHaveBeenCalled()
    expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith('Roster settings changed', expect.any(String))
})

it('drops and continues the pickup from an open resolution modal when limits are known', async () => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    await act(async () => latest.handleResolutionDrop(injured))

    expect(mocks.dropPlayer).toHaveBeenCalledExactlyOnceWith('injured')
    expect(mocks.loadGate).toHaveBeenCalledOnce()
    expect(mocks.addOrRequestDrop).toHaveBeenCalledOnce()
})

it('does not move to IR from an open resolution modal while limits are unknown', async () => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: null })))
    await act(async () => latest.handleResolutionMoveToIR(injured))

    expect(mocks.toggleIR).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith('Roster settings loading', expect.any(String))
})

it.each([
    ['activate', { ...LIMITS, rosterSize: 21 }, 'Roster settings changed'],
    ['activate', null, 'Roster settings loading'],
    ['drop-and-activate', { ...LIMITS, rosterSize: 21 }, 'Roster settings changed'],
    ['drop-and-activate', null, 'Roster settings loading'],
    ['swap', { ...LIMITS, rosterSize: 21 }, 'Roster settings changed'],
    ['swap', null, 'Roster settings loading'],
] as const)('does not write a compound %s after limits become %o while the resolution sheet is open', async (action, next, title) => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    await act(async () => renderer!.update(React.createElement(Probe, { limits: next })))
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    if (action === 'activate') await act(async () => latest.handleIRActivate(injured))
    else if (action === 'drop-and-activate') await act(async () => latest.handleDropAndIRActivate(rosterPlayer({ id: 'drop' }), injured))
    else await act(async () => latest.handleSwapWithInjured(healthyIr, injured))

    expect(mocks.resolveIR).not.toHaveBeenCalled()
    expect(mocks.swap).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith(title, expect.any(String))
    expect(latest.irModal).toBeNull()
})

it.each(['activate', 'drop-and-activate', 'swap'] as const)('alerts and closes when %s is chosen after limits load from an unknown-limit sheet', async action => {
    await mount(null)
    const injured = rosterPlayer({ id: 'injured', is_on_ir: true })
    await act(async () => latest.setIrModal({ ineligible: [injured], roster: [injured], pendingPlayer: incoming, action: 'add', limits: null }))
    await act(async () => renderer!.update(React.createElement(Probe, { limits: LIMITS })))
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    if (action === 'activate') await act(async () => latest.handleIRActivate(injured))
    else if (action === 'drop-and-activate') await act(async () => latest.handleDropAndIRActivate(rosterPlayer({ id: 'drop' }), injured))
    else await act(async () => latest.handleSwapWithInjured(healthyIr, injured))

    expect(mocks.resolveIR).not.toHaveBeenCalled()
    expect(mocks.swap).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith('Roster settings changed', expect.any(String))
    expect(latest.irModal).toBeNull()
})

it.each([
    ['activate', 'team', { memberId: 'synthetic-team-b', leagueId: 'league' }],
    ['drop-and-activate', 'league', { memberId: 'synthetic-team-c', leagueId: 'synthetic-league-2' }],
    ['swap', 'team', { memberId: 'synthetic-team-b', leagueId: 'league' }],
] as const)('synthetic roster: the %s guard turns stale after the manager selects another %s', async (action, _kind, team) => {
    await mount(LIMITS)
    let injured!: ReturnType<typeof rosterPlayer>
    await act(async () => { injured = openResolution() })
    let stillValid: (() => boolean) | undefined
    const capture = async (args: { stillValid?: () => boolean }) => { stillValid = args.stillValid; return { status: 'stale' } }
    mocks.resolveIR.mockImplementation(capture)
    mocks.swap.mockImplementation(capture)
    if (action === 'activate') await act(async () => latest.handleIRActivate(injured))
    else if (action === 'drop-and-activate') await act(async () => latest.handleDropAndIRActivate(rosterPlayer({ id: 'drop' }), injured))
    else await act(async () => latest.handleSwapWithInjured(rosterPlayer({ id: 'ir', is_on_ir: true }), injured))
    expect(stillValid?.()).toBe(true)
    await act(async () => renderer!.update(React.createElement(Probe, { limits: { ...LIMITS }, ...team })))
    mocks.alert.mockClear()
    expect(stillValid?.()).toBe(false)
    expect(mocks.alert).not.toHaveBeenCalled()
})
