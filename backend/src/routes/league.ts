import { FastifyInstance } from 'fastify'
import { advanceSeason } from '../sync/seasonReset'
import { supabase } from '../lib/supabase'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'
import { LeagueIdBody } from '../schemas'

/**
 * Verify the requesting user is a commissioner or co-commissioner of the league.
 */
async function requireCommissioner(userId: string, leagueId: string): Promise<void> {
    const { data, error } = await supabase
        .from('league_members')
        .select('role')
        .eq('league_id', leagueId)
        .eq('user_id', userId)
        .single()

    if (error || !data) {
        throw new AppError('Not authorized for this league', 403)
    }
    if (data.role !== 'commissioner' && data.role !== 'co_commissioner') {
        throw new AppError('Commissioner access required', 403)
    }
}

export default async function leagueRoutes(app: FastifyInstance) {
    app.post('/advance-season', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await requireCommissioner(req.userId, leagueId)
        const result = await advanceSeason(leagueId)
        return { ok: true, ...result }
    })

    // Toggle a player's taxi squad status
    app.patch('/roster/taxi', async (req, reply) => {
        const { rosterPlayerId, isOnTaxi } = req.body as {
            rosterPlayerId: string
            isOnTaxi: boolean
        }
        if (!rosterPlayerId || typeof isOnTaxi !== 'boolean') {
            throw new ValidationError('rosterPlayerId and isOnTaxi required')
        }

        const { data: rp, error: rpError } = await supabase
            .from('roster_players')
            .select('member_id, league_id, league_season_id, player_id')
            .eq('id', rosterPlayerId)
            .single()

        if (rpError || !rp) {
            throw new NotFoundError('Roster player not found')
        }

        // Verify the requesting user owns this roster player
        const { data: member } = await supabase
            .from('league_members')
            .select('user_id')
            .eq('id', rp.member_id)
            .single()

        if (!member || member.user_id !== req.userId) {
            throw new AppError('Not authorized to modify this roster', 403)
        }

        const { error } = await supabase
            .from('roster_players')
            .update({ is_on_taxi: isOnTaxi })
            .eq('id', rosterPlayerId)
        if (error) {
            throw new AppError(error.message, 500)
        }

        // Remove lineup slots when moving to taxi
        if (isOnTaxi) {
            const { error: delError } = await supabase
                .from('weekly_lineups')
                .delete()
                .eq('member_id', rp.member_id)
                .eq('league_id', rp.league_id)
                .eq('league_season_id', rp.league_season_id)
                .eq('player_id', rp.player_id)
            if (delError) {
                app.log.error({ msg: 'Failed to clear lineups on taxi move', error: delError })
            }
        }

        return { ok: true }
    })
}
