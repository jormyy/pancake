import { gameElapsedSeconds } from './gameProgress.ts'
import { assertGameUnambiguous } from './gameIdentity.ts'
import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'
import { errorMessage } from './responses.ts'
import { resolveCdnPlayers } from './playerResolver.ts'
import { resolvePlayerImports } from './playerImports.ts'
import { dateFromETDate } from './scoreShared.ts'
import { runBounded } from './runBounded.ts'
import type { Database } from './database.ts'
import type { CdnGamePlayer } from './cdnGameFetch.ts'

export type StatsSyncGame = Pick<
  Database['public']['Tables']['nba_games']['Row'],
  'id' | 'nba_game_id' | 'week_number' | 'season_year' | 'status'
> & Partial<Pick<Database['public']['Tables']['nba_games']['Row'], 'home_score' | 'away_score' | 'game_status_text'>>

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
      const { data: remaining, error } = await supabase
        .rpc('get_score_sync_games', { p_start_date: dateStr, p_end_date: dateStr })
        .select('id').eq('id', game.id)
      if (error) throw error
      if (!remaining?.length) {
        console.log(`[sync-stats] Game ${game.nba_game_id} left the available score inputs during recovery.`)
        continue
      }
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
    validateBoxScorePlayers(boxScore, providerGameId)
    await recordBoxSides(boxScore, providerGameId)
    const resolved = await resolveBoxScorePlayers(boxScore, providerGameId)
    const stats = resolved.map(({ player, playerId }) =>
      buildStatRow(player, playerId, game.id, game.season_year, game.week_number))
    const changed = boxScore.gameStatus === 3
      ? await saveFinalGameStats(game, providerGameId, stats, boxScore)
      : await saveGameStats(game.id, providerGameId, stats, false, gameElapsedSeconds(boxScore))
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

// A box lists each player under his side. His game membership keeps it, so when this game is the stored
// evidence that he left his team, the ESPN release sweep moves him to this side rather than to no team and
// he stays startable on its game days (resolve_player_imports_atomic). It is recorded before the box's own
// import, so no membership of this box is stored without its side; every path that stores a box does so.
export async function recordBoxSides(
  boxScore: { homeTeam?: { teamTricode?: unknown; players?: NBABoxScorePlayer[] }; awayTeam?: { teamTricode?: unknown; players?: NBABoxScorePlayer[] } },
  providerGameId: string,
): Promise<void> {
  const records = [boxScore.homeTeam, boxScore.awayTeam].flatMap((team) => {
    const side = team?.teamTricode
    return typeof side === 'string' && side.trim() ? (team?.players ?? []).map(player => ({
      provider_id: String(player.personId), display_name: player.name ?? '', nba_game_id: providerGameId, nba_team: side,
      ...player.position && ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].includes(player.position) ? { metadata: { position: player.position } } : {},
    })) : []
  })
  if (records.length > 0) await resolvePlayerImports('nba_cdn', records)
}

type FinalBoxScore = BoxScorePlayers & {
  sourceUpdatedAt?: string
  gameStatusText?: unknown
  homeTeam?: { score?: unknown }
  awayTeam?: { score?: unknown }
}

const isTeamScore = (score: unknown): score is number => Number.isSafeInteger(score) && (score as number) >= 0

// The scoreboard is the only other writer of nba_games scores, and it stops
// polling a game once it is Final or drops it from todaysScoreboard, so the
// last mid-game sample would otherwise stay as the final score. A Final
// sample always applies and every later non-final sample is refused.
// Feeds without team scores keep the earlier behavior. Live-poll work rows
// carry the stored score, so a settled final is not rewritten on each recheck.
export async function saveFinalScore(game: Pick<StatsSyncGame, 'id' | 'status' | 'home_score' | 'away_score' | 'game_status_text'>, providerGameId: string, boxScore: FinalBoxScore): Promise<void> {
  const home = boxScore.homeTeam?.score
  const away = boxScore.awayTeam?.score
  if (!isTeamScore(home) || !isTeamScore(away)) return
  if (game.status === 'Final' && game.home_score === home && game.away_score === away &&
      /^final/i.test(game.game_status_text ?? '')) return
  const text = typeof boxScore.gameStatusText === 'string' && boxScore.gameStatusText.trim() ? boxScore.gameStatusText : 'Final'
  const { error } = await supabase.rpc('save_live_scoreboard_atomic', {
    p_game_id: game.id, p_provider_game_id: providerGameId, p_status: 'Final',
    p_home_score: home, p_away_score: away, p_status_text: text, p_elapsed_seconds: 0,
  })
  if (error) throw error
}

export async function saveFinalGameStats(
  game: Pick<StatsSyncGame, 'id' | 'status' | 'home_score' | 'away_score' | 'game_status_text'>,
  providerGameId: string,
  stats: PlayerGameStatsInsert[],
  boxScore: FinalBoxScore,
): Promise<number> {
  const home = boxScore.homeTeam?.score
  const away = boxScore.awayTeam?.score
  if (boxScore.sourceUpdatedAt && isTeamScore(home) && isTeamScore(away)) {
    const { data, error } = await supabase.rpc('save_final_game_snapshot_atomic', {
      p_game_id: game.id, p_provider_game_id: providerGameId, p_stats: stats,
      p_source_updated_at: boxScore.sourceUpdatedAt, p_home_score: home, p_away_score: away,
      p_status_text: typeof boxScore.gameStatusText === 'string' && boxScore.gameStatusText.trim() ? boxScore.gameStatusText : 'Final',
    })
    if (error) throw error
    return data
  }
  await saveFinalScore(game, providerGameId, boxScore)
  return await saveGameStats(game.id, providerGameId, stats, true)
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
): Promise<Array<{ player: CdnGamePlayer; playerId: string }>> {
  const allPlayers = validateBoxScorePlayers(boxScore, providerGameId)
  const resolved: Array<{ player: CdnGamePlayer; playerId: string }> = []
  const playerIds = await resolveCdnPlayers(allPlayers.map(player => ({
    personId: String(player.personId), displayName: player.name ?? '',
  })), providerGameId)
  for (const [index, player] of allPlayers.entries()) {
    const playerId = playerIds[index]
    if (playerId && player.statistics) {
      resolved.push({ player: { ...player, isHome: index < (boxScore.homeTeam?.players?.length ?? 0) }, playerId })
    }
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
  p: CdnGamePlayer,
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
    is_home: p.isHome ?? null,
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
