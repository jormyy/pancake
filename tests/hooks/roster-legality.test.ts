import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), drop: vi.fn(), move: vi.fn(), activate: vi.fn(), changed: vi.fn(), alert: vi.fn() }))
vi.mock('@/lib/roster', () => ({ getRoster: state.roster, dropPlayer: state.drop, toggleIR: state.move }))
vi.mock('@/lib/roster-add-flow', () => ({ resolveRosterAddIRConflict: state.activate }))
vi.mock('@/lib/alert', () => ({ showAlert: state.alert }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof useRosterLegality>
const taxi = rosterPlayer({ is_on_taxi: true })
taxi.players = { ...taxi.players, years_exp: 2, career_regular_season_games: 65 }
const Probe = ({ member = 'member' }: { member?: string }) => {
    latest = useRosterLegality({ memberId: member, leagueId: 'league', rosterSize: 1, onChanged: state.changed })
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
