import { beforeEach, expect, it, vi } from 'vitest'
import { resolveRosterAddIRConflict, swapHealthyIrWithInjured } from '@/lib/roster-add-flow'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ roster: vi.fn(), activate: vi.fn(), toggleIR: vi.fn(), toggleTaxi: vi.fn(), lock: vi.fn() }))
vi.mock('@/lib/roster', () => ({
    getRoster: state.roster,
    activateRosterPlayerWithOverflow: state.activate,
    toggleIR: state.toggleIR,
    toggleTaxi: state.toggleTaxi,
    addFreeAgent: vi.fn(),
    getTaxiExitPlayerIds: vi.fn(),
}))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: state.lock }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))

const healthyIr = rosterPlayer({ id: 'ir', is_on_ir: true })
const injured = rosterPlayer({ id: 'injured' })
const drop = rosterPlayer({ id: 'drop' })

beforeEach(() => {
    vi.resetAllMocks()
    state.roster.mockResolvedValue([])
    state.lock.mockResolvedValue(null)
})

it('does not write when limits are already stale', async () => {
    const result = await resolveRosterAddIRConflict({ memberId: 'm', leagueId: 'l', activatePlayer: healthyIr, dropPlayer: drop, stillValid: () => false })
    expect(result).toEqual({ status: 'stale' })
    expect(state.activate).not.toHaveBeenCalled()
    expect(state.toggleIR).not.toHaveBeenCalled()
})

it('does not write when limits change during the lock read', async () => {
    let release!: (value: null) => void
    state.lock.mockReturnValueOnce(new Promise<null>(resolve => { release = resolve }))
    let current = true
    const pending = resolveRosterAddIRConflict({ memberId: 'm', leagueId: 'l', activatePlayer: healthyIr, dropPlayer: drop, stillValid: () => current })
    current = false
    release(null)
    expect(await pending).toEqual({ status: 'stale' })
    expect(state.activate).not.toHaveBeenCalled()
})

it('writes once when limits hold through the lock read', async () => {
    const result = await resolveRosterAddIRConflict({ memberId: 'm', leagueId: 'l', activatePlayer: healthyIr, dropPlayer: drop, stillValid: () => true })
    expect(result.status).toBe('resolved')
    expect(state.activate).toHaveBeenCalledExactlyOnceWith('ir', 'ir', 'drop', 'drop')
})

it('does not swap when limits change during the lock read', async () => {
    let release!: (value: null) => void
    state.lock.mockReturnValueOnce(new Promise<null>(resolve => { release = resolve }))
    let current = true
    const pending = swapHealthyIrWithInjured({ memberId: 'm', leagueId: 'l', healthyIrPlayer: healthyIr, injuredPlayer: injured, stillValid: () => current })
    current = false
    release(null)
    expect(await pending).toEqual({ status: 'stale' })
    expect(state.activate).not.toHaveBeenCalled()
})

it('swaps once when limits hold through the lock read', async () => {
    const result = await swapHealthyIrWithInjured({ memberId: 'm', leagueId: 'l', healthyIrPlayer: healthyIr, injuredPlayer: injured, stillValid: () => true })
    expect(result.status).toBe('resolved')
    expect(state.activate).toHaveBeenCalledExactlyOnceWith('ir', 'ir', 'injured', 'ir')
})
