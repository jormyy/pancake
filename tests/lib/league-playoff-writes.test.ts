import { expect, it, vi } from 'vitest'
import { updateLeagueConfiguration } from '@/lib/league'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(async () => ({ data: null, error: null })) } }))
vi.mock('@/lib/pwa-update-guard', () => ({ holdPwaUpdate: () => () => {} }))

it('writes the entrant plan and omits obsolete playoff week keys from old client objects', async () => {
    const settings = {
        playoff_start_week: 8,
        playoff_entrants: 4,
        playoff_round_lengths: [2, 3],
        playoff_total_weeks: 5,
        playoff_round_weeks: [2, 3],
    }
    await updateLeagueConfiguration('league', settings, null)
    expect(supabase.rpc).toHaveBeenCalledWith('update_league_configuration_atomic', {
        p_league_id: 'league',
        p_settings: { playoff_start_week: 8, playoff_entrants: 4, playoff_round_lengths: [2, 3] },
        p_slots: undefined,
    })
})
