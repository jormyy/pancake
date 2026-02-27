import { supabase } from '../lib/supabase'
import { fetchStatsByDate, formatDate } from '../lib/sportsdata'

export async function syncStatsByDate(date: Date) {
  const dateStr = formatDate(date)
  console.log(`[sync] Fetching stats for ${dateStr}...`)

  const raw = await fetchStatsByDate(dateStr)
  if (!raw || raw.length === 0) {
    console.log(`[sync] No stats for ${dateStr}.`)
    return
  }

  // Resolve game IDs from our nba_games table
  const sdGameIds = [...new Set(raw.map((s: any) => String(s.GameID)))]
  const { data: games, error: gErr } = await supabase
    .from('nba_games')
    .select('id, sportsdata_game_id, week_number, season_year')
    .in('sportsdata_game_id', sdGameIds)

  if (gErr) throw gErr

  const gameMap = Object.fromEntries(
    (games ?? []).map((g) => [g.sportsdata_game_id, g]),
  )

  // Resolve player IDs from our players table
  const sdPlayerIds = [...new Set(raw.map((s: any) => String(s.PlayerID)))]
  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('id, sportsdata_id')
    .in('sportsdata_id', sdPlayerIds)

  if (pErr) throw pErr

  const playerMap = Object.fromEntries(
    (players ?? []).map((p) => [p.sportsdata_id, p.id]),
  )

  const stats = raw
    .map((s: any) => {
      const game = gameMap[String(s.GameID)]
      const playerId = playerMap[String(s.PlayerID)]
      if (!game || !playerId) return null

      const ri = (v: any) => (v != null ? Math.round(v) : null) // round to int

      return {
        player_id: playerId,
        game_id: game.id,
        season_year: game.season_year,
        week_number: game.week_number,
        minutes_played: s.Minutes ?? null,           // numeric — keep as-is
        points: ri(s.Points),
        rebounds: ri(s.Rebounds),
        offensive_rebounds: ri(s.OffensiveRebounds),
        defensive_rebounds: ri(s.DefensiveRebounds),
        assists: ri(s.Assists),
        steals: ri(s.Steals),
        blocks: ri(s.BlockedShots),
        turnovers: ri(s.Turnovers),
        personal_fouls: ri(s.PersonalFouls),
        field_goals_made: ri(s.FieldGoalsMade),
        field_goals_attempted: ri(s.FieldGoalsAttempted),
        three_pointers_made: ri(s.ThreePointersMade),
        three_pointers_attempted: ri(s.ThreePointersAttempted),
        free_throws_made: ri(s.FreeThrowsMade),
        free_throws_attempted: ri(s.FreeThrowsAttempted),
        plus_minus: ri(s.PlusMinus),
        double_double: s.DoubleDoubles === 1,
        triple_double: s.TripleDoubles === 1,
        did_not_play: s.Started === null && (s.Minutes === null || s.Minutes === 0),
        updated_at: new Date().toISOString(),
      }
    })
    .filter(Boolean)

  if (stats.length === 0) return

  const { error } = await supabase
    .from('player_game_stats')
    .upsert(stats, { onConflict: 'player_id,game_id' })

  if (error) throw error
  console.log(`[sync] Upserted ${stats.length} stat lines for ${dateStr}.`)
}
