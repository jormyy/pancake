import { beforeEach, expect, it, vi } from 'vitest'
import { getDynastyDecisionInputs } from '@/lib/dynasty-decisions'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), select: vi.fn(), in: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: mocks }))
beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.from.mockReset().mockReturnValue({ select: mocks.select })
    mocks.select.mockReset().mockReturnValue({ in: mocks.in })
    mocks.in.mockReset().mockResolvedValue({ data: [{ id: 'player', nba_team: 'BOS', years_exp: 2, career_regular_season_games: 64, injury_status: 'Out' }], error: null })
})

it('carries the stored career count into the dynasty row before it is shown', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ player_id: 'player', display_name: 'Player', years_exp: 2 }], error: null })
    const rows = await getDynastyDecisionInputs({ leagueId: 'league', memberId: 'member', seasonYear: 2027 })
    expect(rows[0].career_regular_season_games).toBe(64)
    expect(mocks.in).toHaveBeenCalledWith('id', ['player'])
})

it('loads a full rankings page without exceeding the metadata request limit', async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    mocks.rpc.mockResolvedValue({ data: ids.map(player_id => ({ player_id })), error: null })
    mocks.in.mockImplementation(async (_column: string, values: string[]) => {
        if (values.length > 100) return { data: null, error: new TypeError('Load failed') }
        return { data: values.map(id => ({ id, career_regular_season_games: 64 })), error: null }
    })
    const rows = await getDynastyDecisionInputs({ leagueId: 'league', memberId: 'member', seasonYear: 2027 })
    expect(rows).toHaveLength(600)
    expect(rows.every(row => row.career_regular_season_games === 64)).toBe(true)
    expect(mocks.in).toHaveBeenCalledTimes(6)
})
