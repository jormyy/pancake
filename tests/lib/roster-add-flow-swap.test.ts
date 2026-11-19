import { beforeEach, expect, it, vi } from 'vitest'
import { rosterPlayer } from '../helpers/fixtures'

const state = vi.hoisted(() => ({ overflow: vi.fn(), roster: vi.fn(), lock: vi.fn() }))
vi.mock('@/lib/roster', () => ({
    activateRosterPlayerWithOverflow: state.overflow,
    getRoster: state.roster,
    addFreeAgent: vi.fn(),
    toggleIR: vi.fn(),
    toggleTaxi: vi.fn(),
    getTaxiExitPlayerIds: vi.fn(),
}))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: state.lock }))
vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, readScreenView: vi.fn() }))
vi.mock('@/lib/cache/screen-scope', () => ({ screenScope: vi.fn() }))
vi.mock('@/lib/shared/read-admission', () => ({ assertReadActive: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2027 }))

const { swapHealthyIrWithInjured } = await import('@/lib/roster-add-flow')

const healthyIr = rosterPlayer({ id: 'ir-roster', is_on_ir: true })
const injured = rosterPlayer({ id: 'injured-roster' })

beforeEach(() => {
    vi.resetAllMocks()
    state.lock.mockResolvedValue(null)
    state.roster.mockResolvedValue([])
})

it('swaps a healthy IR player with an injured active player through the overflow RPC', async () => {
    const result = await swapHealthyIrWithInjured({
        memberId: 'member', leagueId: 'league', healthyIrPlayer: healthyIr, injuredPlayer: injured,
    })
    expect(state.overflow).toHaveBeenCalledExactlyOnceWith('ir-roster', 'ir', 'injured-roster', 'ir')
    expect(result.status).toBe('resolved')
})

it('refuses the swap when either player is locked', async () => {
    state.lock.mockResolvedValueOnce(null).mockResolvedValueOnce('Injured Star\'s game has already started.')
    const result = await swapHealthyIrWithInjured({
        memberId: 'member', leagueId: 'league', healthyIrPlayer: healthyIr, injuredPlayer: injured,
    })
    expect(result).toEqual({ status: 'locked', message: 'Injured Star\'s game has already started.' })
    expect(state.overflow).not.toHaveBeenCalled()
})
