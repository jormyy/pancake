import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { supabase } from '@/lib/supabase'

export async function setLineupOptimizerEnabled(
    memberId: string,
    leagueId: string,
    seasonId: string,
    enabled: boolean,
): Promise<void> {
    return withPwaMutation('setLineupOptimizerEnabled', async () => {
        const { error } = await supabase.rpc('save_client_settings_atomic', {
            p_kind: 'lineup_optimizer',
            p_settings: { memberId, leagueId, seasonId, enabled },
        })

        if (error) throw error
    })
}

/** Whether the team's lineup is kept updated automatically; on unless the team turned it off. */
export async function getLineupOptimizerEnabled(memberId: string, seasonId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('lineup_optimizer_settings')
        .select('enabled')
        .eq('member_id', memberId)
        .eq('league_season_id', seasonId)
        .maybeSingle()
    if (error) throw error
    return data?.enabled ?? true
}
