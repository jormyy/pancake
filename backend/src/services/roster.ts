import { supabase } from '../lib/supabase'
import { AppError, NotFoundError } from '../plugins/errorHandler'

export async function toggleTaxiStatus(
    rosterPlayerId: string,
    isOnTaxi: boolean,
    userId: string,
): Promise<void> {
    const { data: rp, error: rpError } = await supabase
        .from('roster_players')
        .select('member_id, league_id, league_season_id, player_id')
        .eq('id', rosterPlayerId)
        .single()

    if (rpError || !rp) {
        throw new NotFoundError('Roster player not found')
    }

    const { data: member } = await supabase
        .from('league_members')
        .select('user_id')
        .eq('id', rp.member_id)
        .single()

    if (!member || member.user_id !== userId) {
        throw new AppError('Not authorized to modify this roster', 403)
    }

    const { error } = await supabase
        .from('roster_players')
        .update({ is_on_taxi: isOnTaxi })
        .eq('id', rosterPlayerId)

    if (error) {
        throw new AppError(error.message, 500)
    }

    if (isOnTaxi) {
        const { error: delError } = await supabase
            .from('weekly_lineups')
            .delete()
            .eq('member_id', rp.member_id)
            .eq('league_id', rp.league_id)
            .eq('league_season_id', rp.league_season_id)
            .eq('player_id', rp.player_id)

        if (delError) {
            console.error('Failed to clear lineups on taxi move', delError)
        }
    }
}
