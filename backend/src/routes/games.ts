import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'

export default async function gamesRoutes(app: FastifyInstance) {
    // GET /games/today — today's NBA games with live scores
    // Public endpoint: no auth required (NBA schedule is not sensitive)
    app.get('/today', async () => {
        const today = new Date().toISOString().split('T')[0]
        const { data, error } = await supabase
            .from('nba_games')
            .select('id, nba_game_id, home_team, away_team, home_score, away_score, status, game_status_text, game_date')
            .eq('game_date', today)
            .order('game_status_text', { ascending: true })

        if (error) throw error
        return { games: data ?? [] }
    })
}
