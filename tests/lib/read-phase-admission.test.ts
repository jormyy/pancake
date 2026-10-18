import { beforeEach, expect, it, vi } from 'vitest'
import { getLeagueStandings } from '@/lib/scoring'
import { getWaiverPriorityOrder } from '@/lib/waivers'
import { getPlayerRosterStatus } from '@/lib/roster'

const state = vi.hoisted(() => ({ season: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: state.season, getCurrentSeasonId: state.season, getActiveSeasonId: state.season }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: state.from } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn(), API_URL: 'http://localhost' }))
beforeEach(() => {
    vi.clearAllMocks()
    state.from.mockImplementation(() => {
        const query = {
            select: () => query, eq: () => query, order: () => query, is: () => query, gt: () => query, limit: () => query,
            maybeSingle: async () => ({ data: null, error: null }),
            then: (resolve: (value: { data: never[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        }
        return query
    })
})

it.each(['standings', 'priority', 'pickup'] as const)('does not start %s queries after a held season lookup crosses suspension', async resource => {
    let release!: (value: unknown) => void
    state.season.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    let active = true
    const canRead = () => active
    const pending = resource === 'standings' ? getLeagueStandings('league', canRead)
        : resource === 'priority' ? getWaiverPriorityOrder('league', canRead)
        : getPlayerRosterStatus('player', 'member', 'league', canRead)
    const refused = expect(pending).rejects.toThrow('Read is no longer active')
    active = false
    release(resource === 'standings' ? { id: 'season', seasonYear: 2026 } : 'season')
    await refused
    expect(state.from).not.toHaveBeenCalled()
})


it('allows each phase for a current active reader', async () => {
    state.season.mockResolvedValueOnce({ id: 'season', seasonYear: 2026 }).mockResolvedValue('season')
    await expect(getLeagueStandings('league', () => true)).resolves.toEqual([])
    await expect(getWaiverPriorityOrder('league', () => true)).resolves.toEqual([])
    await expect(getPlayerRosterStatus('player', 'member', 'league', () => true)).resolves.toEqual({ status: 'free_agent' })
    expect(state.from).toHaveBeenCalledTimes(5)
})
