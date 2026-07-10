import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'
import { errorMessage } from './responses.ts'
import { loadCdnPlayerResolver, persistNbaIdUpdates, resolveCdnPlayer } from './playerResolver.ts'
import type { Database } from './database.ts'

export type StatsSyncGame = Pick<
  Database['public']['Tables']['nba_games']['Row'],
  'id' | 'nba_game_id' | 'week_number' | 'season_year' | 'status'
>
type PlayerGameStatsInsert = Database['public']['Tables']['player_game_stats']['Insert']

// Returns YYYY-MM-DD for the given Date in America/New_York (ET).
// nba_games.game_date is ET-keyed; using UTC here misses prime-time games
// between 0:00 and 5:00 UTC (= 19:00–00:00 ET) where UTC is one day ahead.
function toETDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function syncStatsByDate(date: Date): Promise<number> {
  const dateStr = toETDate(date)
  console.log(`[sync-stats] Fetching stats for ${dateStr}...`)

  const isPast = dateStr < toETDate(new Date())
  const games = await statsGamesForDate(dateStr)
  if (!games?.length) {
    console.log(`[sync-stats] No completed/live games for ${dateStr}.`)
    return 0
  }

  let statCount = 0
  const resolver = await loadCdnPlayerResolver()
  const syncFailures: string[] = []

  for (const game of games) {
    try {
      statCount += await syncStatsGameWithResolver(game, resolver, isPast)
    } catch (e) {
      console.error(`[sync-stats] Error for ${game.nba_game_id}:`, errorMessage(e))
      syncFailures.push(`${game.nba_game_id}: ${errorMessage(e)}`)
    }
  }

  await persistNbaIdUpdates(resolver.nbaIdUpdates)
  if (resolver.nbaIdUpdates.length > 0) {
    console.log(`[sync-stats] Mapped ${resolver.nbaIdUpdates.length} new NBA person IDs.`)
  }

  if (syncFailures.length > 0) {
    throw new Error(`[sync-stats] Failed to sync ${syncFailures.length} game(s) for ${dateStr}: ${syncFailures.join('; ')}`)
  }

  console.log(`[sync-stats] Upserted ${statCount} stat lines for ${dateStr}.`)
  return statCount
}

export async function findNextStatsGame(dateStr: string, afterGameId?: string): Promise<StatsSyncGame | null> {
  const games = await statsGamesForDate(dateStr, afterGameId, 1)
  return games[0] ?? null
}

export async function syncStatsGame(game: StatsSyncGame): Promise<number> {
  const resolver = await loadCdnPlayerResolver()
  const statLines = await syncStatsGameWithResolver(game, resolver, true)
  await persistNbaIdUpdates(resolver.nbaIdUpdates)
  return statLines
}

async function statsGamesForDate(dateStr: string, afterGameId?: string, limit?: number): Promise<StatsSyncGame[]> {
  const isPast = dateStr < toETDate(new Date())
  let query = supabase
    .from('nba_games')
    .select('id, nba_game_id, week_number, season_year, status')
    .eq('game_date', dateStr)
    .like('nba_game_id', '002%')
    .order('id', { ascending: true })
  if (!isPast) query = query.neq('status', 'Scheduled')
  if (afterGameId) query = query.gt('id', afterGameId)
  if (limit !== undefined) query = query.limit(limit)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function syncStatsGameWithResolver(
  game: StatsSyncGame,
  resolver: Awaited<ReturnType<typeof loadCdnPlayerResolver>>,
  skipScheduled: boolean,
): Promise<number> {
  if (!game.nba_game_id) throw new Error(`NBA game ${game.id} is missing its provider id`)
  const boxScore = await fetchBoxScore(game.nba_game_id)
  if (skipScheduled && boxScore.gameStatus === 1) return 0

  const allPlayers = [
    ...(boxScore.homeTeam?.players ?? []),
    ...(boxScore.awayTeam?.players ?? []),
  ]
  const stats: PlayerGameStatsInsert[] = []
  for (const player of allPlayers) {
    const playerId = await resolveCdnPlayer(resolver, String(player.personId), player.name ?? '')
    if (playerId && player.statistics) {
      stats.push(buildStatRow(player, playerId, game.id, game.season_year, game.week_number))
    }
  }

  if (stats.length > 0) {
    const { error } = await supabase
      .from('player_game_stats')
      .upsert(stats, { onConflict: 'player_id,game_id' })
    if (error) throw error
  }
  if (boxScore.gameStatus === 3 && game.status !== 'Final') {
    const { error } = await supabase
      .from('nba_games')
      .update({ status: 'Final', updated_at: new Date().toISOString() })
      .eq('id', game.id)
    if (error) throw error
  }
  return stats.length
}

export function buildStatRow(
  p: NBABoxScorePlayer,
  playerId: string,
  gameId: string,
  seasonYear: number,
  weekNumber: number,
): PlayerGameStatsInsert {
  const s = p.statistics
  const minutesPlayed = parseNBAMinutes(s.minutes)
  const dnp = minutesPlayed == null

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
