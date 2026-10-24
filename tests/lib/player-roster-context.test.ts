import { beforeEach, expect, it, vi } from 'vitest'
import { getPlayerRosterContext } from '@/lib/roster'

const state = vi.hoisted(() => ({ from: vi.fn(), season: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: state.from } }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: state.season }))

function query(data: unknown, error: Error | null = null) {
    const response = { data, error }
    return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(), gt: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue(response),
        then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
    }
}

const ownRow = { id: 'own-row', player_id: 'own', member_id: 'member', is_on_ir: true, league_members: { team_name: 'Mine' } }
const otherRow = { id: 'other-row', player_id: 'other', member_id: 'opponent', is_on_ir: true, league_members: { team_name: 'Theirs' } }

beforeEach(() => {
    vi.resetAllMocks()
    state.season.mockResolvedValue('season')
})

it.each([
    ['own', { status: 'mine', rosterPlayerId: 'own-row' }],
    ['other', { status: 'taken', ownerTeamName: 'Theirs' }],
    ['free', { status: 'free_agent' }],
])('reads ownership and own IR occupancy together for %s', async (playerId, status) => {
    const rosterQuery = query([ownRow, ...(playerId === 'other' ? [otherRow] : [])])
    const waiverQuery = query(null)
    state.from.mockImplementation(table => table === 'roster_players' ? rosterQuery : waiverQuery)
    await expect(getPlayerRosterContext(playerId as string, 'member', 'league')).resolves.toEqual({
        status, roster: [{ is_on_ir: true }],
    })
    expect(rosterQuery.select).toHaveBeenCalledWith('id, player_id, member_id, is_on_ir, league_members ( team_name )')
    expect(rosterQuery.eq.mock.calls).toEqual([['league_id', 'league'], ['league_season_id', 'season']])
    expect(rosterQuery.or).toHaveBeenCalledExactlyOnceWith(`player_id.eq.${playerId},member_id.eq.member`)
    expect(state.from.mock.calls).toEqual(playerId === 'free' ? [['roster_players'], ['waiver_wire_log']] : [['roster_players']])
})

it('keeps waiver status and own occupancy in the same snapshot', async () => {
    const rosterQuery = query([ownRow])
    const waiverQuery = query({ id: 'log', clears_at: '2099-01-01T00:00:00Z' })
    state.from.mockImplementation(table => table === 'roster_players' ? rosterQuery : waiverQuery)
    await expect(getPlayerRosterContext('waived', 'member', 'league')).resolves.toEqual({
        status: { status: 'on_waivers', logId: 'log', clearsAt: '2099-01-01T00:00:00Z' },
        roster: [{ is_on_ir: true }],
    })
    expect(waiverQuery.eq.mock.calls).toEqual([
        ['league_id', 'league'], ['league_season_id', 'season'], ['player_id', 'waived'],
    ])
    expect(waiverQuery.is).toHaveBeenCalledWith('cleared_at', null)
    expect(waiverQuery.gt).toHaveBeenCalledWith('clears_at', expect.any(String))
})

it('rejects a failed occupancy read instead of reporting an empty IR', async () => {
    state.from.mockReturnValue(query(null, new Error('Roster unavailable')))
    await expect(getPlayerRosterContext('free', 'member', 'league')).rejects.toThrow('Roster unavailable')
    expect(state.from).toHaveBeenCalledExactlyOnceWith('roster_players')
})

it('does not read a roster without an active season', async () => {
    state.season.mockResolvedValue(null)
    await expect(getPlayerRosterContext('free', 'member', 'league')).resolves.toEqual({ status: { status: 'free_agent' }, roster: [] })
    expect(state.from).not.toHaveBeenCalled()
})
