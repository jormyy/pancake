import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { todayET } from '../lib/utils/date'

export default async function gamesRoutes(app: FastifyInstance) {
    // GET /games/today — today's NBA games with live scores
    // Public endpoint: no auth required (NBA schedule is not sensitive)
    app.get('/today', async () => {
        const today = todayET()
        // Order by tipoff time (chronological) — game_status_text is free-form
        // ("Q3 5:23", "Halftime", "Final") and produces alphabetical noise.
        // Status string ('Scheduled' | 'InProgress' | 'Final') doesn't sort
        // semantically either, so we order by game_time (ISO tipoff timestamp)
        // with status and id as deterministic tiebreakers.
        const { data, error } = await supabase
            .from('nba_games')
            .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date')
            .eq('game_date', today)
            .order('game_time', { ascending: true, nullsFirst: false })
            .order('status', { ascending: true })
            .order('id', { ascending: true })

        if (error) throw error
        return { games: data ?? [] }
    })
}
