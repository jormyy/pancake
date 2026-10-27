import { beforeEach, expect, it, vi } from 'vitest'
import { loadPickupState } from '@/lib/roster-add-flow'
import { setSessionOwner } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({ read: vi.fn(), cached: null as unknown }))
vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: state.read, cachedScreenView: () => state.cached ? { value: state.cached } : undefined }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2027 }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
const transactionState = { weeklyAddCount: 1, weeklyAddLimit: 2, faabBalance: 70 }
const payload = () => ({ roster: { roster: [] as { id: string; is_on_taxi: boolean; players: { id: string } }[], claims: [] as { playerId: string; status: string }[], transactionState }, ownership: null as null | { memberId: string; teamName: string; isOnTaxi: boolean }, clearsAt: null as null | string })
beforeEach(() => { vi.clearAllMocks(); setSessionOwner('account'); state.cached = null; state.read.mockResolvedValue(payload()) })

it('reads ownership, pickup limits and pending claims from one authorized player view', async () => {
    const result = await loadPickupState('player', 'member', 'league', () => true, true)
    expect(result).toEqual({ status: { status: 'free_agent' }, roster: [], transactionState, claimPending: false })
    expect(state.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: 'account', leagueId: 'league', memberId: 'member', screen: 'player', params: expect.objectContaining({ playerId: 'player', seasonYear: 2027 }) }))
})

it('keeps the server ownership result when a pickup hint is stale', async () => {
    const view = payload(); view.ownership = { memberId: 'other', teamName: 'Other', isOnTaxi: true }
    state.read.mockResolvedValue(view)
    expect(await loadPickupState('player', 'member', 'league', () => true, true)).toMatchObject({ status: { status: 'taken', ownerTeamName: 'Other', isOnTaxi: true } })
})

it('reads a rostered player and its taxi location without separate limit requests', async () => {
    const view = payload(); view.roster.roster = [{ id: 'roster', is_on_taxi: true, players: { id: 'player' } }]
    state.read.mockResolvedValue(view)
    expect(await loadPickupState('player', 'member', 'league')).toMatchObject({ status: { status: 'mine', rosterPlayerId: 'roster', isOnTaxi: true }, transactionState })
    expect(state.read).toHaveBeenCalledOnce()
})

it.each([null, '2099-01-01'])('reads pending claims for pickup status with clearsAt=%s', async clearsAt => {
    const view = payload(); view.clearsAt = clearsAt; view.roster.claims = [{ playerId: 'player', status: 'pending' }]
    state.read.mockResolvedValue(view)
    expect(await loadPickupState('player', 'member', 'league', () => true, true)).toMatchObject({ claimPending: true, status: { status: clearsAt ? 'on_waivers' : 'free_agent' } })
})

it('ignores terminal claims and claims for another player', async () => {
    const view = payload(); view.roster.claims = [{ playerId: 'player', status: 'awarded' }, { playerId: 'other', status: 'pending' }]
    state.read.mockResolvedValue(view)
    expect(await loadPickupState('player', 'member', 'league')).toMatchObject({ claimPending: false })
})

it('uses the scoped cached view without another request', async () => {
    state.cached = payload()
    expect(await loadPickupState('player', 'member', 'league')).toMatchObject({ transactionState })
    expect(state.read).not.toHaveBeenCalled()
})

it('starts no reads after the screen loses admission', async () => {
    await expect(loadPickupState('player', 'member', 'league', () => false)).rejects.toThrow('no longer active')
    expect(state.read).not.toHaveBeenCalled()
})

it('rejects a completed view after the screen loses admission', async () => {
    let active = true
    let finish!: (value: ReturnType<typeof payload>) => void
    state.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = loadPickupState('player', 'member', 'league', () => active)
    active = false; finish(payload())
    await expect(pending).rejects.toThrow('no longer active')
})
