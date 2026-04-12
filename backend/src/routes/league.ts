import { FastifyInstance } from 'fastify'
import { advanceSeason } from '../sync/seasonReset'
import { supabase } from '../lib/supabase'
import { LeagueIdBody } from '../schemas'

export default async function leagueRoutes(app: FastifyInstance) {
    app.post('/advance-season', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
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
            reply.status(400)
            return { ok: false, error: 'rosterPlayerId and isOnTaxi required' }
        }

        const { data: rp } = await supabase
            .from('roster_players')
            .select('member_id, league_id, league_season_id, player_id')
            .eq('id', rosterPlayerId)
            .single()

        if (!rp) {
            reply.status(404)
            return { ok: false, error: 'Roster player not found' }
        }

        const { error } = await supabase
            .from('roster_players')
            .update({ is_on_taxi: isOnTaxi })
            .eq('id', rosterPlayerId)
        if (error) {
            reply.status(500)
            return { ok: false, error: error.message }
        }

        // Remove lineup slots when moving to taxi
        if (isOnTaxi) {
            await supabase
                .from('weekly_lineups')
                .delete()
                .eq('member_id', (rp as any).member_id)
                .eq('league_id', (rp as any).league_id)
                .eq('league_season_id', (rp as any).league_season_id)
                .eq('player_id', (rp as any).player_id)
        }

        return { ok: true }
    })
}
