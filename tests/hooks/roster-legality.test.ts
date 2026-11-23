import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import type { RosterLimits } from '@/lib/roster-capacity'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), drop: vi.fn(), move: vi.fn(), activate: vi.fn(), swap: vi.fn(), changed: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ getRoster: state.roster, dropPlayer: state.drop, toggleIR: state.move }))
vi.mock('@/lib/roster-add-flow', () => ({ resolveRosterAddIRConflict: state.activate, swapHealthyIrWithInjured: state.swap }))
vi.mock('@/lib/alert', () => ({ showAlert: state.alert }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useRosterLegality>
const taxi = rosterPlayer({ is_on_taxi: true })
taxi.players = { ...taxi.players, years_exp: 2, career_regular_season_games: 65 }
const Probe = ({ member = 'member', limits = { rosterSize: 1, irSlots: 2, taxiSlots: 0 } }: { member?: string; limits?: RosterLimits | null }) => {
    latest = useRosterLegality({ memberId: member, leagueId: 'league', limits, onChanged: state.changed })
    return null
}
beforeEach(async () => { vi.resetAllMocks(); state.roster.mockResolvedValue([taxi]); state.activate.mockResolvedValue({ status: 'resolved', roster: [], remaining: [] }); await act(async () => { screen = create(React.createElement(Probe)) }) })
afterEach(async () => { await act(async () => screen?.unmount()) })
it('blocks acquisition for taxi problems and closes after a permitted drop repairs the roster', async () => {
    let allowed = true
    await act(async () => { allowed = await latest.check() })
    expect(allowed).toBe(false)
    expect(latest.modalProps.ineligibleIR).toEqual([taxi])
    expect(latest.modalProps.visible).toBe(true)
    state.roster.mockResolvedValue([])
    await act(async () => latest.modalProps.onDrop(taxi))
    expect(state.drop).toHaveBeenCalledExactlyOnceWith(taxi.id)
    expect(latest.modalProps.visible).toBe(false)
    expect(state.changed).toHaveBeenCalledOnce()
})
it.each(['PA005', 'PA009'])('opens the same sheet for stale server error %s and leaves unrelated errors to their caller', async code => {
    state.roster.mockResolvedValue([])
    await act(async () => { expect(await latest.report({ code, message: 'Server roster problem' })).toBe(true) })
    expect(latest.modalProps.visible).toBe(true)
    expect(latest.modalProps.serverMessage).toBe('Server roster problem')
    expect(await latest.report({ code: 'PA001' })).toBe(false)
})
it('ignores an old roster response across an owner switch and return', async () => {
    let finish!: (rows: typeof taxi[]) => void
    state.roster.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    let pending!: Promise<boolean>
    await act(async () => { pending = latest.check() })
    await act(async () => screen.update(React.createElement(Probe, { member: 'other' })))
    await act(async () => screen.update(React.createElement(Probe)))
    await act(async () => { finish([taxi]); await pending })
    expect(latest.modalProps.visible).toBe(false)
    expect(latest.modalProps.ineligibleIR).toEqual([])
})

it('swaps a healthy IR player with an injured active player through the overflow flow', async () => {
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    const injured = rosterPlayer({ id: 'injured' })
    state.roster.mockResolvedValue([])
    state.swap.mockResolvedValue({ status: 'resolved', roster: [], remaining: [] })
    await act(async () => latest.modalProps.onSwapWithInjured(healthyIr, injured))
    expect(state.swap).toHaveBeenCalledExactlyOnceWith({
        memberId: 'member', leagueId: 'league', healthyIrPlayer: healthyIr, injuredPlayer: injured, rosterSize: 1,
        stillValid: expect.any(Function),
    })
    expect(state.changed).toHaveBeenCalledOnce()
})

it('fails closed while limits are unknown and detects a real overflow once they arrive', async () => {
    state.roster.mockResolvedValue([rosterPlayer({ id: 'a' }), rosterPlayer({ id: 'b' })])
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    let allowed = true
    await act(async () => { allowed = await latest.check() })
    expect(allowed).toBe(false)
    expect(latest.modalProps.visible).toBe(false)
    expect(await latest.report({ code: 'PA005', message: 'Server roster problem' })).toBe(false)

    await act(async () => screen.update(React.createElement(Probe, { limits: { rosterSize: 1, irSlots: 2, taxiSlots: 0 } })))
    await act(async () => { allowed = await latest.check() })
    expect(allowed).toBe(false)
    expect(latest.modalProps.visible).toBe(true)

    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    await act(async () => { allowed = await latest.check() })
    expect(allowed).toBe(false)
})

it('does not report success when an activation cannot check capacity', async () => {
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    const ir = rosterPlayer({ id: 'ir', is_on_ir: true })
    await act(async () => latest.modalProps.onActivate(ir))
    expect(state.activate).not.toHaveBeenCalled()
    expect(state.changed).not.toHaveBeenCalled()
})

it('does not report success when a swap cannot check capacity', async () => {
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    const injured = rosterPlayer({ id: 'injured' })
    await act(async () => latest.modalProps.onSwapWithInjured(healthyIr, injured))
    expect(state.swap).not.toHaveBeenCalled()
    expect(state.changed).not.toHaveBeenCalled()
})

it.each([
    ['drop-and-activate', { rosterSize: 2, irSlots: 2, taxiSlots: 0 }, 'Roster settings changed'],
    ['drop-and-activate', null, 'Roster settings loading'],
    ['swap', { rosterSize: 2, irSlots: 2, taxiSlots: 0 }, 'Roster settings changed'],
    ['swap', null, 'Roster settings loading'],
] as const)('does not write a compound %s after limits become %o while the sheet is open', async (action, next, title) => {
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    const injured = rosterPlayer({ id: 'injured' })
    await act(async () => { await latest.check() })
    await act(async () => screen.update(React.createElement(Probe, { limits: next })))
    if (action === 'drop-and-activate') await act(async () => latest.modalProps.onDropAndActivate(injured, healthyIr))
    else await act(async () => latest.modalProps.onSwapWithInjured(healthyIr, injured))
    expect(state.activate).not.toHaveBeenCalled()
    expect(state.swap).not.toHaveBeenCalled()
    expect(state.alert).toHaveBeenCalledWith(title, expect.any(String))
    expect(latest.modalProps.visible).toBe(false)
})

it('alerts and closes when a swap is chosen after limits load from an unknown-limit sheet', async () => {
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    await act(async () => { await latest.check() })
    await act(async () => screen.update(React.createElement(Probe, { limits: { rosterSize: 1, irSlots: 2, taxiSlots: 0 } })))
    const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
    const injured = rosterPlayer({ id: 'injured' })
    await act(async () => latest.modalProps.onSwapWithInjured(healthyIr, injured))
    expect(state.swap).not.toHaveBeenCalled()
    expect(state.alert).toHaveBeenCalledWith('Roster settings changed', expect.any(String))
    expect(latest.modalProps.visible).toBe(false)
})

it('lets a capacity-neutral edit through while limits are unknown but still blocks eligibility problems', async () => {
    await act(async () => screen.update(React.createElement(Probe, { limits: null })))
    const healthy = [rosterPlayer({ id: 'a' }), rosterPlayer({ id: 'b' })]
    let allowed = false
    await act(async () => { allowed = await latest.check(healthy, undefined, false) })
    expect(allowed).toBe(true)
    expect(latest.modalProps.visible).toBe(false)
    await act(async () => { allowed = await latest.check(healthy) })
    expect(allowed).toBe(false)
    await act(async () => { allowed = await latest.check([taxi], undefined, false) })
    expect(allowed).toBe(false)
    expect(latest.modalProps.visible).toBe(true)
    expect(latest.modalProps.ineligibleIR).toEqual([taxi])
})
