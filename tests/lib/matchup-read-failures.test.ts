import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failure: '' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from(table: string) {
    let single = false
    const query = {
        select: () => query, eq: () => query, lte: () => query, or: () => query, in: () => query,
        maybeSingle: () => { single = true; return query },
        then(resolve: (result: unknown) => unknown) {
            const kind = table === 'league_members' ? 'members' : single ? 'matchup' : 'records'
            const data = kind === 'matchup' ? {
                id: 'matchup', week_number: 1, end_week_number: null, home_member_id: 'mine', away_member_id: 'other',
                home_points: 100, away_points: 90, is_finalized: false, winner_member_id: null,
            } : kind === 'members' ? [
                { id: 'mine', team_name: 'My real team', profiles: { display_name: 'Me' } },
                { id: 'other', team_name: 'Their real team', profiles: { display_name: 'Them' } },
            ] : [{ home_member_id: 'mine', away_member_id: 'other', winner_member_id: 'mine' }]
            return Promise.resolve(resolve(state.failure === kind
                ? { data: null, error: new Error(`${kind} unavailable`) }
                : { data, error: null }))
        },
    }
    return query
} } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: async () => ({ id: 'season', seasonYear: 2027 }) }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: async () => 1 }))
import { getMyMatchup } from '@/lib/scoring'

beforeEach(() => { state.failure = '' })

it.each(['members', 'records'])('rejects failed %s reads instead of inventing names or zero records', async (failure) => {
    state.failure = failure
    await expect(getMyMatchup('mine', 'league')).rejects.toThrow(`${failure} unavailable`)
    state.failure = ''
    await expect(getMyMatchup('mine', 'league')).resolves.toMatchObject({
        myTeamName: 'My real team', opponentTeamName: 'Their real team', myWins: 1, opponentLosses: 1,
    })
})
