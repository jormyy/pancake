import { gameElapsedSeconds } from './gameProgress.ts'
import { assertGameUnambiguous } from './gameIdentity.ts'
import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'
import { errorMessage } from './responses.ts'
import { resolveCdnPlayers } from './playerResolver.ts'
import { dateFromETDate } from './scoreShared.ts'
import { runBounded } from './runBounded.ts'
import type { Database } from './database.ts'

export type StatsSyncGame = Pick<
  Database['public']['Tables']['nba_games']['Row'],
  'id' | 'nba_game_id' | 'week_number' | 'season_year' | 'status'
>

const FINAL_STATS_RECHECK_MS = 30 * 60 * 1000
const FINAL_NUMERIC_STATS = [
  'assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
  'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points',
  'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals',
  'threePointersAttempted', 'threePointersMade', 'turnovers',
] as const satisfies readonly (keyof NBABoxScorePlayer['statistics'])[]
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
  const syncFailures: string[] = []

  for (const game of games) {
    try {
      statCount += await syncGameBoxScore(game, isPast)
    } catch (e) {
      console.error(`[sync-stats] Error for ${game.nba_game_id}:`, errorMessage(e))
      syncFailures.push(`${game.nba_game_id}: ${errorMessage(e)}`)
    }
  }

  if (syncFailures.length > 0) {
    throw new Error(`[sync-stats] Failed to sync ${syncFailures.length} game(s) for ${dateStr}: ${syncFailures.join('; ')}`)
  }

  console.log(`[sync-stats] Upserted ${statCount} stat lines for ${dateStr}.`)
  return statCount
}

export async function syncStatsForDates(
  dateKeys: string[],
  onDateError?: (dateKey: string, error: unknown) => void,
): Promise<number> {
  if (dateKeys.length === 0) return 0

  let statCount = 0
  const failures: unknown[] = []
  for (const dateKey of dateKeys) {
    try {
      statCount += await syncStatsByDate(dateFromETDate(dateKey))
    } catch (error) {
      if (onDateError) onDateError(dateKey, error)
      else failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Stats sync failed for some dates')
  return statCount
}

export async function findNextStatsGame(dateStr: string, afterGameId?: string): Promise<StatsSyncGame | null> {
  const games = await statsGamesForDate(dateStr, afterGameId, 1)
  return games[0] ?? null
}

export async function syncStatsGame(game: StatsSyncGame): Promise<number> {
  return syncGameBoxScore(game, true)
}

async function statsGamesForDate(dateStr: string, afterGameId?: string, limit?: number): Promise<StatsSyncGame[]> {
  const isPast = dateStr < toETDate(new Date())
  let query = supabase
    .rpc('get_score_sync_games', { p_start_date: dateStr, p_end_date: dateStr })
    .select('id, nba_game_id, week_number, season_year, status')
    .like('nba_game_id', '002%')
    .order('id', { ascending: true })
  if (!isPast) query = query.neq('status', 'Scheduled')
  // Skip Final games whose stats were synced within the recheck window; they
  // get re-fetched (for stat corrections) once the fence expires.
  const recheckCutoff = new Date(Date.now() - FINAL_STATS_RECHECK_MS).toISOString()
  query = query.or(`status.neq.Final,stats_synced_at.is.null,stats_synced_at.lt.${recheckCutoff}`)
  if (afterGameId) query = query.gt('id', afterGameId)
  if (limit !== undefined) query = query.limit(limit)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function syncGameBoxScore(
  game: StatsSyncGame,
  skipScheduled: boolean,
  persist: (write: () => Promise<number>) => Promise<number> = write => write(),
): Promise<number> {
  const providerGameId = game.nba_game_id
  if (!providerGameId) throw new Error(`NBA game ${game.id} is missing its provider id`)
  const boxScore = await fetchBoxScore(providerGameId)
  if (game.status === 'Final' && boxScore.gameStatus !== 3) {
    throw new Error(`Final game box score is not final for ${providerGameId}`)
  }
  if (skipScheduled && boxScore.gameStatus === 1) return 0

  return await persist(() => retrySourceContention(async () => {
    await assertGameUnambiguous(game.id)
    const resolved = await resolveBoxScorePlayers(boxScore, providerGameId)
    const stats = resolved.map(({ player, playerId }) =>
      buildStatRow(player, playerId, game.id, game.season_year, game.week_number))
    const changed = await saveGameStats(game.id, providerGameId, stats, boxScore.gameStatus === 3, boxScore.gameStatus === 3 ? undefined : gameElapsedSeconds(boxScore))
    if (changed > 0) console.log(`[sync-stats] Game ${providerGameId}: ${changed}/${stats.length} stat line(s) changed.`)
    return stats.length
  }))
}

async function retrySourceContention<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const failure = error as { code?: string; message?: string } | null
      if (attempt >= 4 || failure?.code !== 'PT409' || failure?.message !== 'Game inputs are being updated. Retry this operation.') throw error
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt))
    }
  }
}

type BoxScorePlayers = {
  gameStatus?: number
  homeTeam?: { players?: NBABoxScorePlayer[] }
  awayTeam?: { players?: NBABoxScorePlayer[] }
}

export function validateBoxScorePlayers(boxScore: BoxScorePlayers, providerGameId: string): NBABoxScorePlayer[] {
  const allPlayers = [
    ...(boxScore.homeTeam?.players ?? []),
    ...(boxScore.awayTeam?.players ?? []),
  ]
  if (boxScore.gameStatus === 3 &&
      (!boxScore.homeTeam?.players?.length || !boxScore.awayTeam?.players?.length)) {
    throw new Error(`Final box score has an empty team for ${providerGameId}`)
  }
  if (boxScore.gameStatus === 3 && allPlayers.some((player) =>
    !player.statistics || typeof player.statistics.minutes !== 'string' ||
    FINAL_NUMERIC_STATS.some((key) => !Number.isFinite(player.statistics[key])))) {
    throw new Error(`Final box score has incomplete statistics for ${providerGameId}`)
  }
  return allPlayers
}

// Final imports must map every complete provider row before any stats are saved.
export async function resolveBoxScorePlayers(
  boxScore: BoxScorePlayers,
  providerGameId: string,
): Promise<Array<{ player: NBABoxScorePlayer; playerId: string }>> {
  const allPlayers = validateBoxScorePlayers(boxScore, providerGameId)
  const resolved: Array<{ player: NBABoxScorePlayer; playerId: string }> = []
  const playerIds = await resolveCdnPlayers(allPlayers.map(player => ({
    personId: String(player.personId), displayName: player.name ?? '',
  })))
  for (const [index, player] of allPlayers.entries()) {
    const playerId = playerIds[index]
    if (playerId && player.statistics) resolved.push({ player, playerId })
  }
  if (boxScore.gameStatus === 3 && resolved.length !== allPlayers.length) {
    throw new Error(`Final box score has unresolved player stats for ${providerGameId}`)
  }
  return resolved
}

export async function saveGameStats(
  gameId: string,
  providerGameId: string,
  stats: PlayerGameStatsInsert[],
  isFinal: boolean,
  elapsedSeconds?: number,
): Promise<number> {
  const { data, error } = isFinal ? await supabase.rpc('save_game_stats_atomic', {
    p_game_id: gameId,
    p_provider_game_id: providerGameId,
    p_stats: stats,
    p_is_final: true,
  }) : await supabase.rpc('save_live_game_stats_atomic', {
    p_game_id: gameId, p_provider_game_id: providerGameId, p_stats: stats, p_elapsed_seconds: elapsedSeconds!,
  })
  if (error) throw error
  return data
}

export function buildStatRow(
  p: NBABoxScorePlayer,
  playerId: string,
  gameId: string,
  seasonYear: number,
  weekNumber: number,
): PlayerGameStatsInsert {
  const s = p.statistics
  const parsedMinutes = typeof s.minutes === 'string' ? parseNBAMinutes(s.minutes) : null
  const minutesPlayed = parsedMinutes != null && Number.isFinite(parsedMinutes) ? parsedMinutes : null
  // The CDN includes zero-minute rows for both DNPs and players who appeared.
  // Only explicit provider flags override the legacy minutes fallback.
  const dnp = p.played === '0' || p.played === 0
    ? true
    : p.played === '1' || p.played === 1
      ? false
      : minutesPlayed == null

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

export async function syncLiveStatsGames(games: StatsSyncGame[]): Promise<{ statLines: number; failures: unknown[] }> {
  let statLines = 0
  const failures: unknown[] = []
  let writes: Promise<number> = Promise.resolve(0)
  const persist = (write: () => Promise<number>) => {
    const pending = writes.then(write, write)
    writes = pending
    return pending
  }
  await runBounded(games.map(game => async () => {
    try {
      const lines = await syncGameBoxScore(game, true, persist)
      statLines += lines
    } catch (error) {
      failures.push(error)
    }
  }), 4)
  return { statLines, failures }
}
