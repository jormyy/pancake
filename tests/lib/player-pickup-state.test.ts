import { beforeEach, expect, it, vi } from 'vitest'
import { loadPickupState } from '@/lib/roster-add-flow'

const state = vi.hoisted(() => ({ context: vi.fn(), limit: vi.fn(), pending: vi.fn() }))
vi.mock('@/lib/roster', () => ({
    getPlayerRosterContext: state.context, activateRosterPlayerWithOverflow: vi.fn(), addFreeAgent: vi.fn(), getRoster: vi.fn(), toggleIR: vi.fn(),
}))
vi.mock('@/lib/league', () => ({ getMemberTransactionState: state.limit }))
vi.mock('@/lib/waivers', () => ({ getPendingWaiverPlayerIdsForSeason: state.pending }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))

beforeEach(() => {
    vi.clearAllMocks()
    state.limit.mockResolvedValue({ weeklyAddCount: 0 })
    state.pending.mockResolvedValue(new Set())
})

it('reads known pickup limits beside ownership without waiting for the roster response', async () => {
    let release!: (value: unknown) => void
    state.context.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const result = loadPickupState('player', 'member', 'league', () => true, true)
    expect(state.limit).toHaveBeenCalledExactlyOnceWith('member', 'league')
    release({ status: { status: 'free_agent' }, roster: [{ is_on_ir: true }] })
    expect(await result).toEqual({ status: { status: 'free_agent' }, roster: [{ is_on_ir: true }], transactionState: { weeklyAddCount: 0 }, claimPending: false })
    expect(state.limit).toHaveBeenCalledOnce()
    expect(state.pending).toHaveBeenCalledExactlyOnceWith('member', 'season')
})

it('keeps the server ownership result when a pickup hint is stale', async () => {
    state.context.mockResolvedValue({ status: { status: 'taken', ownerTeamName: 'Other' }, roster: [] })
    expect(await loadPickupState('player', 'member', 'league', () => true, true)).toMatchObject({
        status: { status: 'taken', ownerTeamName: 'Other' }, transactionState: null,
    })
})

it('skips pickup limits for rostered players without a hint', async () => {
    state.context.mockResolvedValue({ status: { status: 'mine', rosterPlayerId: 'roster' }, roster: [] })
    await loadPickupState('player', 'member', 'league')
    expect(state.limit).not.toHaveBeenCalled()
})

it.each([{ status: 'free_agent' }, { status: 'on_waivers', logId: 'wire', clearsAt: 'later' }])('reads pending claims for pickup status $status', async status => {
    state.context.mockResolvedValue({ status, roster: [] })
    state.pending.mockResolvedValue(new Set(['player']))
    expect(await loadPickupState('player', 'member', 'league', () => true, true)).toMatchObject({ claimPending: true })
    expect(state.pending).toHaveBeenCalledExactlyOnceWith('member', 'season')
    expect(state.limit).toHaveBeenCalledOnce()
})

it('starts no reads after the screen loses admission', async () => {
    await expect(loadPickupState('player', 'member', 'league', () => false, true)).rejects.toThrow()
    expect(state.context).not.toHaveBeenCalled()
    expect(state.limit).not.toHaveBeenCalled()
})
