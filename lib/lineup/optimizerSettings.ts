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
