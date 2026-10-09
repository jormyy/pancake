import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ member: true, failSeason: false, failWeeks: false, reads: [] as string[], filters: [] as [string, unknown][] }))
vi.mock('@/lib/supabase', () => ({ supabase: { from(table: string) {
    const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { state.filters.push([key, value]); return query },
        order: () => query,
        maybeSingle: () => query,
        then(resolve: (value: unknown) => unknown) {
            state.reads.push(table)
            const data = table === 'league_members' ? (state.member ? { id: 'member' } : null)
                : table === 'league_seasons' ? { id: 'season', season_year: 2027 }
                    : [{ week_number: 1, week_start: '2026-10-05', week_end: '2026-10-11' }]
            const error = table === 'league_seasons' && state.failSeason ? new Error('season unavailable')
                : table === 'season_weeks' && state.failWeeks ? new Error('weeks unavailable') : null
            return Promise.resolve(resolve({ data, error }))
        },
    }
    return query
} } }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-08' }))
import { getLineupContext } from '@/lib/lineup/read'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { invalidateWeekNumberCache } from '@/lib/shared/week'

beforeEach(() => {
    state.member = true; state.failSeason = false; state.failWeeks = false; state.reads = []; state.filters = []
    invalidateSeasonCache(); invalidateWeekNumberCache()
})
const owner = { userId: 'owner', memberId: 'member' }

describe('Lineup context recovery authority', () => {
    it('checks the exact membership and revalidates season and week despite a recent cached success', async () => {
        await getLineupContext('league')
        state.reads = []
        await expect(getLineupContext('league', owner)).resolves.toMatchObject({ seasonId: 'season', weekNumber: 1, today: '2026-10-08' })
        expect(state.reads).toEqual(['league_members', 'league_seasons', 'season_weeks'])
        expect(state.filters).toEqual(expect.arrayContaining([['id', 'member'], ['league_id', 'league'], ['user_id', 'owner']]))
    })
    it.each(['season', 'weeks'])('does not confer context when the required %s read fails after a cached success', async (failed) => {
        await getLineupContext('league', owner)
        state.failSeason = failed === 'season'; state.failWeeks = failed === 'weeks'
        await expect(getLineupContext('league', owner)).rejects.toThrow(`${failed} unavailable`)
    })
    it('refuses a removed membership before returning cached league context', async () => {
        await getLineupContext('league', owner)
        state.member = false; state.reads = []
        await expect(getLineupContext('league', owner)).resolves.toBeNull()
        expect(state.reads).toEqual(['league_members'])
    })
    it('recovers only after the required request succeeds', async () => {
        state.failSeason = true
        await expect(getLineupContext('league', owner)).rejects.toThrow('season unavailable')
        state.failSeason = false
        await expect(getLineupContext('league', owner)).resolves.toMatchObject({ seasonId: 'season' })
    })
})
