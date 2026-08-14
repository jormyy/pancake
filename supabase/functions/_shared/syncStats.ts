import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'
import { errorMessage } from './responses.ts'
import {
  loadCdnPlayerResolver,
  persistNbaIdUpdates,
  resolveCdnPlayer,
  type CdnPlayerResolver,
} from './playerResolver.ts'
import { dateFromETDate } from './scoreShared.ts'
import type { Database } from './database.ts'

export type StatsSyncGame = Pick<
  Database['public']['Tables']['nba_games']['Row'],
  'id' | 'nba_game_id' | 'week_number' | 'season_year' | 'status'
>

// How long a Final game's synced stats stay fresh before we re-fetch its box
// score. Live-poll calls syncStatsForDates every minute during live windows;
// without this fence every already-Final game (all of yesterday's plus today's
// finished games) got a CDN box-score fetch and a full player_game_stats
// read/diff per tick. A 30-minute recheck cadence still catches NBA stat
// corrections promptly, and the daily/weekly correction paths
// (syncStatsForCompletedWeeks' 4-day window) flow through the same query, so
// corrections keep propagating — just at most twice an hour per game.
const FINAL_STATS_RECHECK_MS = 30 * 60 * 1000
type PlayerGameStatsInsert = Database['public']['Tables']['player_game_stats']['Insert']

// Returns YYYY-MM-DD for the given Date in America/New_York (ET).
// nba_games.game_date is ET-keyed; using UTC here misses prime-time games
// between 0:00 and 5:00 UTC (= 19:00–00:00 ET) where UTC is one day ahead.
function toETDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function syncStatsByDate(
  date: Date,
  sharedResolver?: CdnPlayerResolver,
): Promise<number> {
  const dateStr = toETDate(date)
  console.log(`[sync-stats] Fetching stats for ${dateStr}...`)

  const isPast = dateStr < toETDate(new Date())
  const games = await statsGamesForDate(dateStr)
  if (!games?.length) {
    console.log(`[sync-stats] No completed/live games for ${dateStr}.`)
    return 0
  }

  let statCount = 0
  const resolver = sharedResolver ?? (await loadCdnPlayerResolver())
  const syncFailures: string[] = []

  for (const game of games) {
    try {
      statCount += await syncStatsGameWithResolver(game, resolver, isPast)
    } catch (e) {
      console.error(`[sync-stats] Error for ${game.nba_game_id}:`, errorMessage(e))
      syncFailures.push(`${game.nba_game_id}: ${errorMessage(e)}`)
    }
  }

  // A shared resolver spans several dates and accumulates ids across all of them;
  // its owner persists once at the end so we do not rewrite the same list per date.
  if (!sharedResolver) await flushNbaIdUpdates(resolver)

  if (syncFailures.length > 0) {
    throw new Error(`[sync-stats] Failed to sync ${syncFailures.length} game(s) for ${dateStr}: ${syncFailures.join('; ')}`)
  }

  console.log(`[sync-stats] Upserted ${statCount} stat lines for ${dateStr}.`)
  return statCount
}

// Syncs several dates on one shared player resolver. Loading it per date costs a
// full paginated players scan each time, which dominates a multi-date re-sync.
export async function syncStatsForDates(dateKeys: string[]): Promise<number> {
  if (dateKeys.length === 0) return 0

  const resolver = await loadCdnPlayerResolver()
  let statCount = 0
  try {
    for (const dateKey of dateKeys) {
      statCount += await syncStatsByDate(dateFromETDate(dateKey), resolver)
    }
  } finally {
    // A failing date must not cost us the id mappings resolved before it; the
    // per-date path persisted before throwing, and this keeps that guarantee.
    await flushNbaIdUpdates(resolver)
  }
  return statCount
}

async function flushNbaIdUpdates(resolver: CdnPlayerResolver): Promise<void> {
  await persistNbaIdUpdates(resolver.nbaIdUpdates)
  if (resolver.nbaIdUpdates.length > 0) {
    console.log(`[sync-stats] Mapped ${resolver.nbaIdUpdates.length} new NBA person IDs.`)
  }
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

  const changed = await unchangedStatRowsRemoved(game.id, stats)
  if (changed.length > 0) {
    const { error } = await supabase
      .from('player_game_stats')
      .upsert(changed, { onConflict: 'player_id,game_id' })
    if (error) throw error
    console.log(`[sync-stats] Game ${game.nba_game_id}: ${changed.length}/${stats.length} stat line(s) changed.`)
  }
  // Callers report this as stat lines synced for the game; keep that meaning
  // rather than silently redefining the metric as "rows written".
  if (boxScore.gameStatus === 3) {
    // Stamp stats_synced_at so statsGamesForDate can skip this Final game for
    // the next FINAL_STATS_RECHECK_MS instead of re-fetching every tick.
    const update: Database['public']['Tables']['nba_games']['Update'] = {
      stats_synced_at: new Date().toISOString(),
    }
    if (game.status !== 'Final') {
      update.status = 'Final'
      update.updated_at = new Date().toISOString()
    }
    const { error } = await supabase
      .from('nba_games')
      .update(update)
      .eq('id', game.id)
    if (error) throw error
  }
  return stats.length
}

// Columns that decide whether a box score actually moved. updated_at is excluded
// on purpose: it is the signal loadEarliestStatCorrectionWeek uses to detect a
// stat correction, so rewriting it on an unchanged re-sync would make every
// re-sync look like a correction and drag the scoring reach-back back to week 1.
const COMPARED_STAT_COLUMNS = [
  'player_id',
  'game_id',
  'season_year',
  'week_number',
  'minutes_played',
  'points',
  'rebounds',
  'offensive_rebounds',
  'defensive_rebounds',
  'assists',
  'steals',
  'blocks',
  'turnovers',
  'personal_fouls',
  'field_goals_made',
  'field_goals_attempted',
  'three_pointers_made',
  'three_pointers_attempted',
  'free_throws_made',
  'free_throws_attempted',
  'plus_minus',
  'double_double',
  'triple_double',
  'did_not_play',
] as const

async function unchangedStatRowsRemoved(
  gameId: string,
  rows: PlayerGameStatsInsert[],
): Promise<PlayerGameStatsInsert[]> {
  if (rows.length === 0) return rows

  const { data, error } = await supabase
    .from('player_game_stats')
    .select(COMPARED_STAT_COLUMNS.join(','))
    .eq('game_id', gameId)
  if (error) throw error

  return changedStatRows(rows, (data ?? []) as unknown as Record<string, unknown>[])
}

// Pure half of the diff, kept separate so it is testable without a database.
export function changedStatRows(
  rows: PlayerGameStatsInsert[],
  storedRows: Record<string, unknown>[],
): PlayerGameStatsInsert[] {
  const stored = new Map<string, Record<string, unknown>>(
    storedRows.map((row) => [String(row.player_id), row]),
  )
  return rows.filter((row) => !statRowMatchesStored(row, stored.get(String(row.player_id))))
}

function statRowMatchesStored(
  row: PlayerGameStatsInsert,
  stored: Record<string, unknown> | undefined,
): boolean {
  if (!stored) return false
  return COMPARED_STAT_COLUMNS.every((column) =>
    normalizeStatValue((row as Record<string, unknown>)[column]) === normalizeStatValue(stored[column]),
  )
}

// Postgres returns numerics as strings ("12.50"); normalize both sides through
// Number so formatting alone never counts as a change.
function normalizeStatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const numeric = Number(value)
  if (value !== '' && !Number.isNaN(numeric)) return String(numeric)
  return String(value)
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
