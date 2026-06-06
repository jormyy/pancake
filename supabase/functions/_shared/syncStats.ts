import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'
import { errorMessage } from './responses.ts'
import { loadCdnPlayerResolver, persistNbaIdUpdates, resolveCdnPlayer } from './playerResolver.ts'

// Returns YYYY-MM-DD for the given Date in America/New_York (ET).
// nba_games.game_date is ET-keyed; using UTC here misses prime-time games
// between 0:00 and 5:00 UTC (= 19:00–00:00 ET) where UTC is one day ahead.
function toETDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function syncStatsByDate(date: Date) {
  const dateStr = toETDate(date)
  console.log(`[sync-stats] Fetching stats for ${dateStr}...`)

  const isPast = dateStr < toETDate(new Date())
  let query = supabase
    .from('nba_games')
    .select('id, nba_game_id, week_number, season_year, status')
    .eq('game_date', dateStr)
    .not('nba_game_id', 'is', null)
    .not('nba_game_id', 'like', '003%')
  if (!isPast) query = query.neq('status', 'Scheduled')
  const { data: games, error: gErr } = await query

  if (gErr) throw gErr
  if (!games?.length) {
    console.log(`[sync-stats] No completed/live games for ${dateStr}.`)
    return
  }

  let statCount = 0
  const resolver = await loadCdnPlayerResolver()

  for (const game of games) {
    try {
      const boxScore = await fetchBoxScore(game.nba_game_id!)
      const allPlayers = [
        ...(boxScore.homeTeam?.players ?? []),
        ...(boxScore.awayTeam?.players ?? []),
      ]

      const stats: any[] = []

      for (const p of allPlayers) {
        const personId = String(p.personId)
        const playerId = await resolveCdnPlayer(resolver, personId, p.name ?? '')
        if (!playerId) continue
        if (!p.statistics) continue

        stats.push(buildStatRow(p, playerId, game.id, game.season_year, game.week_number))
      }

      if (stats.length) {
        const { error } = await supabase
          .from('player_game_stats')
          .upsert(stats, { onConflict: 'player_id,game_id' })
        if (error) throw error
        statCount += stats.length
      }

      if (boxScore.gameStatus === 3 && game.status !== 'Final') {
        const { error: statusError } = await supabase
          .from('nba_games')
          .update({ status: 'Final', updated_at: new Date().toISOString() })
          .eq('id', game.id)
        if (statusError) throw statusError
      }
    } catch (e) {
      console.error(`[sync-stats] Error for ${game.nba_game_id}:`, errorMessage(e))
    }
  }

  await persistNbaIdUpdates(resolver.nbaIdUpdates)
  if (resolver.nbaIdUpdates.length > 0) {
    console.log(`[sync-stats] Mapped ${resolver.nbaIdUpdates.length} new NBA person IDs.`)
  }

  console.log(`[sync-stats] Upserted ${statCount} stat lines for ${dateStr}.`)
}

export function buildStatRow(
  p: NBABoxScorePlayer,
  playerId: string,
  gameId: string,
  seasonYear: number,
  weekNumber: number | null,
): Record<string, unknown> {
  const s = p.statistics
  const minutesPlayed = parseNBAMinutes(s.minutes)
  const dnp = !minutesPlayed || minutesPlayed < 0.5

  const reb = s.reboundsTotal ?? 0
  const ast = s.assists ?? 0
  const pts = s.points ?? 0
  const stl = s.steals ?? 0
  const blk = s.blocks ?? 0

  const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length

  return {
    player_id: playerId,
    game_id: gameId,
    season_year: seasonYear,
    week_number: weekNumber,
    minutes_played: minutesPlayed,
    points: pts,
    rebounds: reb,
    offensive_rebounds: s.reboundsOffensive ?? null,
    defensive_rebounds: s.reboundsDefensive ?? null,
    assists: ast,
    steals: stl,
    blocks: blk,
    turnovers: s.turnovers ?? null,
    personal_fouls: s.foulsPersonal ?? null,
    field_goals_made: s.fieldGoalsMade ?? null,
    field_goals_attempted: s.fieldGoalsAttempted ?? null,
    three_pointers_made: s.threePointersMade ?? null,
    three_pointers_attempted: s.threePointersAttempted ?? null,
    free_throws_made: s.freeThrowsMade ?? null,
    free_throws_attempted: s.freeThrowsAttempted ?? null,
    plus_minus: s.plusMinusPoints ?? null,
    double_double: statCats >= 2,
    triple_double: statCats >= 3,
    did_not_play: dnp,
    updated_at: new Date().toISOString(),
  }
}
