import { afterEach, expect, it, vi } from 'vitest'
import { addFreeAgent, getTaxiExitPlayerIds } from '@/lib/roster'
import { resolveRosterAddIRConflict } from '@/lib/roster-add-flow'
import { rosterPlayer } from '../helpers/fixtures'

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), readRoster: vi.fn(), taxi: vi.fn(), ir: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: boundary.rpc, from: boundary.from } }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: async () => null }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: async () => null }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
afterEach(() => vi.clearAllMocks())
it.each([[false, false], [true, false], [false, true]])('sends both named destination flags: IR %s taxi %s', async (toIr, toTaxi) => {
    boundary.rpc.mockResolvedValue({ error: null })
    await addFreeAgent('member', 'league', 'player', toIr, toTaxi)
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith('add_free_agent_atomic', {
        p_member_id: 'member', p_league_id: 'league', p_player_id: 'player', p_to_ir: toIr, p_to_taxi: toTaxi,
    })
})
it('scopes permanent taxi exit reads to this member and league', async () => {
    const last = vi.fn().mockResolvedValue({ data: [{ player_id: 'exited' }], error: null })
    const first = vi.fn(() => ({ eq: last }))
    const select = vi.fn(() => ({ eq: first }))
    boundary.from.mockReturnValue({ select })
    expect(await getTaxiExitPlayerIds('member', 'league')).toEqual(new Set(['exited']))
    expect(boundary.from).toHaveBeenCalledWith('league_member_taxi_exits')
    expect(first).toHaveBeenCalledWith('member_id', 'member')
    expect(last).toHaveBeenCalledWith('league_id', 'league')
})
it('uses the taxi activation source for a compound drop and activate', async () => {
    const player = rosterPlayer({ is_on_taxi: true })
    boundary.rpc.mockResolvedValue({ error: null })
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) }
    boundary.from.mockReturnValue(query)
    await resolveRosterAddIRConflict({ memberId: 'member', leagueId: 'league', activatePlayer: player, dropPlayer: rosterPlayer({ id: 'drop' }) })
    expect(boundary.rpc).toHaveBeenCalledWith('activate_roster_player_with_overflow_atomic', {
        p_activate_roster_player_id: player.id, p_activate_source: 'taxi', p_free_roster_player_id: 'drop', p_free_action: 'drop',
    })
})
