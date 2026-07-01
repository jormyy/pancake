import { supabase } from '@/lib/supabase'

export async function getLineupOptimizerEnabled(
    memberId: string,
    leagueId: string,
    seasonId: string,
): Promise<boolean> {
    const { data, error } = await (supabase as any)
        .from('lineup_optimizer_settings')
        .select('enabled')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)
        .maybeSingle()

    if (error) throw error
    return Boolean(data?.enabled)
}

export async function setLineupOptimizerEnabled(
    memberId: string,
    leagueId: string,
    seasonId: string,
    enabled: boolean,
): Promise<void> {
    const { error } = await (supabase as any)
        .from('lineup_optimizer_settings')
        .upsert({
            member_id: memberId,
            league_id: leagueId,
            league_season_id: seasonId,
            enabled,
            enabled_at: enabled ? new Date().toISOString() : null,
        }, {
            onConflict: 'league_id,league_season_id,member_id',
        })

    if (error) throw error
}
