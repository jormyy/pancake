import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRosterLegality } from '@/hooks/use-roster-legality'
import type { RosterLimits } from '@/lib/roster-capacity'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), lock: vi.fn(), writes: [] as string[], alert: vi.fn(), changed: vi.fn() }))
vi.mock('@/lib/roster', () => ({
    getRoster: state.roster,
    getTaxiExitPlayerIds: vi.fn(),
    addFreeAgent: vi.fn(),
    dropPlayer: async (id: string) => { state.writes.push(`drop:${id}`) },
    toggleIR: async (id: string, on: boolean) => { state.writes.push(`ir:${id}:${on}`) },
    toggleTaxi: async (id: string, on: boolean) => { state.writes.push(`taxi:${id}:${on}`) },
    activateRosterPlayerWithOverflow: async (id: string, source: string, free: string, action: string) => { state.writes.push(`activate:${id}:${source}:${free}:${action}`) },
}))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: state.lock }))
vi.mock('@/lib/alert', () => ({ showAlert: state.alert }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LIMITS: RosterLimits = { rosterSize: 1, irSlots: 1, taxiSlots: 0 }
const TEAM_A = { memberId: 'synthetic-team-a', leagueId: 'synthetic-league-1' }
const switches = [
    ['team', { memberId: 'synthetic-team-b', leagueId: 'synthetic-league-1' }],
    ['league', { memberId: 'synthetic-team-c', leagueId: 'synthetic-league-2' }],
] as const

const healthy = rosterPlayer({ id: 'synthetic-healthy-ir', is_on_ir: true })
healthy.players = { ...healthy.players, injury_status: null }
const injured = rosterPlayer({ id: 'synthetic-injured-active' })
injured.players = { ...injured.players, injury_status: 'Out' }
const filler = rosterPlayer({ id: 'synthetic-filler-active' })

let screen: ReactTestRenderer
let latest: ReturnType<typeof useRosterLegality>
const Probe = ({ team }: { team: { memberId: string; leagueId: string } }) => {
    latest = useRosterLegality({ ...team, limits: { ...LIMITS }, onChanged: state.changed })
    return null
}

let releaseLock: (message: string | null) => void
beforeEach(async () => {
    vi.resetAllMocks()
    state.writes.length = 0
    state.roster.mockResolvedValue([healthy, injured, filler])
    const gate = new Promise<string | null>(resolve => { releaseLock = resolve })
    state.lock.mockImplementation(() => gate)
    await act(async () => { screen = create(React.createElement(Probe, { team: TEAM_A })) })
    await act(async () => { await latest.check() })
})
afterEach(async () => { await act(async () => screen?.unmount()) })

const actions = {
    activate: () => latest.modalProps.onActivate(healthy),
    'drop-and-activate': () => latest.modalProps.onDropAndActivate(filler, healthy),
    swap: () => latest.modalProps.onSwapWithInjured(healthy, injured),
} as const
const cases = (Object.keys(actions) as (keyof typeof actions)[]).flatMap(action => switches.map(([kind, team]) => [action, kind, team] as const))

it.each(cases)('synthetic roster: cancels %s when the manager selects another %s during the lock read', async (action, _kind, team) => {
    expect(latest.modalProps.visible).toBe(true)
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => { pending = actions[action]() })
    await act(async () => screen.update(React.createElement(Probe, { team })))
    await act(async () => { releaseLock(null); await pending })
    expect(state.writes).toEqual([])
    expect(state.alert).not.toHaveBeenCalled()
    expect(state.changed).not.toHaveBeenCalled()
})

it.each(Object.keys(actions) as (keyof typeof actions)[])('synthetic roster: still writes %s once when the manager stays on the team', async action => {
    let pending: Promise<unknown> = Promise.resolve()
    await act(async () => { pending = actions[action]() })
    await act(async () => screen.update(React.createElement(Probe, { team: { ...TEAM_A } })))
    await act(async () => { releaseLock(null); await pending })
    expect(state.writes).toHaveLength(1)
})
