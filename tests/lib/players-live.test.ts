import { describe, expect, it, vi } from 'vitest'
import { applyVisiblePlayerTotals, getVisiblePlayerTotals, type VisiblePlayerTotals } from '@/lib/players'
import { supabase } from '@/lib/supabase'
import { playerRow } from '../helpers/fixtures'
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
const row = (overrides: Partial<VisiblePlayerTotals> = {}): VisiblePlayerTotals => ({
    player_id: 'player-a', rounded_fantasy_average: null, game_status: 'Scheduled', game_time: '2026-10-24T20:00:00Z', started_at: null,
    totals: { games_played: 2, points: 41, points_count: 2, rebounds: 20, rebounds_count: 2,
        double_double: 2, triple_double: 1, field_goals_attempted: 30, minutes_played: 65.5, minutes_played_count: 2 }, ...overrides,
})
describe('visible player display', () => {
    it('scores exact totals, shooting penalties and bonus counts before dividing', () => {
        const result = applyVisiblePlayerTotals(playerRow(), row(), { points: 1, rebounds: 1.2, double_double: 2, triple_double: 3, field_goals_attempted: -0.5 })
        expect(result.avg_fantasy_points).toBe(28.5)
        expect(result.avg_points).toBe(20.5)
        expect(result.avg_minutes_played).toBe(32.75)
        expect(result.avg_assists).toBeNull()
    })
    it('uses the server rounding result for coefficients beyond two decimals', () => {
        expect(applyVisiblePlayerTotals(playerRow(), row({ rounded_fantasy_average: 6.83 }), { points: 0.333 }).avg_fantasy_points).toBe(6.83)
    })
    it('keeps missing FP unknown when league scoring has not loaded', () => {
        expect(applyVisiblePlayerTotals(playerRow(), row(), null).avg_fantasy_points).toBeNull()
        expect(applyVisiblePlayerTotals(playerRow(), row({ totals: {} }), { points: 1 }).avg_points).toBeNull()
    })
    it('starts the live label at tipoff and removes it when the game ends or is postponed', () => {
        expect(applyVisiblePlayerTotals(playerRow(), row(), {}, Date.parse('2026-10-24T19:59:59Z')).playing_now).toBe(false)
        expect(applyVisiblePlayerTotals(playerRow(), row(), {}, Date.parse('2026-10-24T20:00:00Z')).playing_now).toBe(true)
        for (const status of ['Final', 'Postponed']) expect(applyVisiblePlayerTotals(playerRow(), row({ game_status: status }), {}, Date.parse('2026-10-24T22:00:00Z')).playing_now).toBe(false)
    })
    it('limits reads to visible IDs and refuses an oversized page', async () => {
        vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null, count: null, status: 200, statusText: 'OK' })
        await getVisiblePlayerTotals('league', ['a', 'b'], 2027)
        expect(supabase.rpc).toHaveBeenCalledWith('get_visible_player_totals', { p_league_id: 'league', p_player_ids: ['a', 'b'], p_season_year: 2027 })
        await expect(getVisiblePlayerTotals('league', Array(51).fill('a'), 2027)).rejects.toThrow('50')
    })
})
