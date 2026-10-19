import { supabase } from '@/lib/supabase'
import type { RosterPlayer } from '@/lib/roster'
import { todayET } from '@/lib/shared/dates'

export async function getRosterStatusChangeLockMessage(rosterPlayer: RosterPlayer | null | undefined): Promise<string | null> {
    if (!rosterPlayer) return null

    const team = rosterPlayer.players.nba_team
    if (!team) return null

    const today = todayET()
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const { data, error } = await supabase.from('nba_games')
        .select('home_team, away_team, game_date, status, game_time, started_at')
        .in('game_date', [yesterday, today])
    if (error) throw error
    const now = Date.now()
    const recentStart = (value: string | null, gameDate: string) => value != null &&
        Date.parse(value) <= now && (gameDate === today || Date.parse(value) >= now - 12 * 60 * 60_000)
    const locked = (data ?? []).some(game => (game.home_team === team || game.away_team === team) && (
        game.status === 'InProgress' || (game.game_date === today && game.status === 'Final') ||
        recentStart(game.game_time, game.game_date) || recentStart(game.started_at, game.game_date)
    ))
    if (!locked) return null

    return `${rosterPlayer.players.display_name}'s game has already started. IR and taxi changes are locked for today's slate.`
}
