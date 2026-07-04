import { supabase } from '../_shared/supabase.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { serveInternal } from '../_shared/serve.ts'
import type { Database, Json } from '../_shared/database.ts'
import { parseFantasyProsProjectionHtml, type FantasyProsProjectionType } from './parser.ts'
import {
  buildFantasyProsProjectionPayload,
  type PlayerForProjection,
  type FantasyProsProjectionInsert,
} from './match.ts'

const LOOKBACK_WEEKS = 4
const CHUNK = 500
const FANTASYPROS_DELAY_MS = 5000
const PARSER_VERSION = 'fantasypros-html-v1'

const FANTASYPROS_SOURCES: {
  projectionType: FantasyProsProjectionType
  url: string
}[] = [
  { projectionType: 'daily', url: 'https://www.fantasypros.com/nba/projections/daily-overall.php' },
  { projectionType: 'weekly_avg', url: 'https://www.fantasypros.com/nba/projections/avg-weekly-overall.php' },
  { projectionType: 'weekly_total', url: 'https://www.fantasypros.com/nba/projections/weekly-overall.php' },
]

class ProjectionFetchError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message)
    this.name = 'ProjectionFetchError'
  }
}

type SourceResult = {
  projectionType: FantasyProsProjectionType
  status: 'success' | 'failed' | 'skipped'
  rows: number
  matched: number
  unmatched: number
  error?: string
}
type InternalFallbackStatRow = {
  player_id: string
  points: number | null
  rebounds: number | null
  assists: number | null
  steals: number | null
  blocks: number | null
  turnovers: number | null
  three_pointers_made: number | null
  field_goals_made: number | null
  field_goals_attempted: number | null
  free_throws_made: number | null
  free_throws_attempted: number | null
  double_double: boolean | null
  triple_double: boolean | null
  minutes_played: number | null
  did_not_play: boolean | null
}
type ProjectionSyncRunInsert = Database['public']['Tables']['projection_sync_runs']['Insert']
type ProjectionSyncRunUpdate = Database['public']['Tables']['projection_sync_runs']['Update']
type InternalProjectionUpsert = Database['public']['Tables']['player_projections']['Insert']

serveInternal('sync-projections', async () => {
  const result = await syncProjections()
  return Response.json({ ok: true, ...result })
})

async function syncProjections(): Promise<{ fantasypros: SourceResult[]; internalFallback: number }> {
  const seasonYear = currentSeasonYear()
  const today = new Date()
  const projectionDate = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const weekNumber = await getCurrentRegularSeasonWeekNumber(today, seasonYear)
  const players = await fetchPlayersForProjection()

  const fantasypros: SourceResult[] = []
  for (let i = 0; i < FANTASYPROS_SOURCES.length; i += 1) {
    if (i > 0) await sleep(FANTASYPROS_DELAY_MS)
    const source = FANTASYPROS_SOURCES[i]
    fantasypros.push(
      await syncFantasyProsSource({
        ...source,
        seasonYear,
        weekNumber,
        projectionDate: source.projectionType === 'daily' ? projectionDate : null,
        players,
      }),
    )
  }

  const internalFallback = await syncInternalFallbackProjections(seasonYear, weekNumber)
  return { fantasypros, internalFallback }
}

async function syncFantasyProsSource({
  projectionType,
  url,
  seasonYear,
  weekNumber,
  projectionDate,
  players,
}: {
  projectionType: FantasyProsProjectionType
  url: string
  seasonYear: number
  weekNumber: number | null
  projectionDate: string | null
  players: PlayerForProjection[]
}): Promise<SourceResult> {
  const run = await createSyncRun({
    projectionType,
    url,
    seasonYear,
    weekNumber,
    projectionDate,
  })

  try {
    const fetchedAt = new Date().toISOString()
    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; PancakeProjectionSync/1.0; +https://pancake.app)',
      },
    })
    const html = await response.text()
    if (!response.ok) {
      throw new ProjectionFetchError(`FantasyPros ${projectionType} fetch failed with HTTP ${response.status}`, response.status)
    }

    const parsedRows = parseFantasyProsProjectionHtml(html)
    if (parsedRows.length === 0) {
      const message = `No FantasyPros ${projectionType} projection rows parsed from public HTML`
      await finishSyncRun(run.id, {
        status: 'skipped',
        httpStatus: response.status,
        rowCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        errorMessage: message,
        metadata: {
          parserVersion: PARSER_VERSION,
          crawlDelaySeconds: 5,
          sourceConstraint: 'public FantasyPros HTML only',
        },
      })
      console.warn(`[sync-projections] FantasyPros ${projectionType} skipped: ${message}`)
      return { projectionType, status: 'skipped', rows: 0, matched: 0, unmatched: 0, error: message }
    }

    const payload = buildFantasyProsProjectionPayload({
      runId: run.id,
      projectionType,
      sourceUrl: url,
      rows: parsedRows,
      players,
      fetchedAt,
      seasonYear,
      weekNumber,
      projectionDate,
    })

    await insertProjectionRows(payload.rows)
    await finishSyncRun(run.id, {
      status: 'success',
      httpStatus: response.status,
      rowCount: payload.rows.length,
      matchedCount: payload.matched,
      unmatchedCount: payload.unmatched,
      metadata: {
        parserVersion: PARSER_VERSION,
        crawlDelaySeconds: 5,
        sourceConstraint: 'public FantasyPros HTML only',
      },
    })

    console.log(
      `[sync-projections] FantasyPros ${projectionType}: ${payload.matched}/${payload.rows.length} matched.`,
    )
    return {
      projectionType,
      status: 'success',
      rows: payload.rows.length,
      matched: payload.matched,
      unmatched: payload.unmatched,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const httpStatus = error instanceof ProjectionFetchError ? error.httpStatus : undefined
    console.warn(`[sync-projections] FantasyPros ${projectionType} failed: ${message}`)
    await finishSyncRun(run.id, {
      status: 'failed',
      httpStatus,
      errorMessage: message,
      metadata: {
        parserVersion: PARSER_VERSION,
        crawlDelaySeconds: 5,
        sourceConstraint: 'public FantasyPros HTML only',
      },
    })
    return { projectionType, status: 'failed', rows: 0, matched: 0, unmatched: 0, error: message }
  }
}

async function createSyncRun({
  projectionType,
  url,
  seasonYear,
  weekNumber,
  projectionDate,
}: {
  projectionType: FantasyProsProjectionType
  url: string
  seasonYear: number
  weekNumber: number | null
  projectionDate: string | null
}): Promise<{ id: string }> {
  const insertPayload: ProjectionSyncRunInsert = {
    source: 'fantasypros',
    projection_type: projectionType,
    source_url: url,
    season_year: seasonYear,
    week_number: weekNumber,
    projection_date: projectionDate,
    parser_version: PARSER_VERSION,
    status: 'running',
    source_metadata: {
      crawlDelaySeconds: 5,
      disallowedPaths: ['/api/', '/json/', '/xml/', '/ajax/'],
    },
  }

  const { data, error } = await supabase
    .from('projection_sync_runs')
    .insert(insertPayload)
    .select('id')
    .single()
  if (error) throw error
  return data
}

async function finishSyncRun(
  runId: string,
  update: {
    status: 'success' | 'failed' | 'skipped'
    httpStatus?: number
    rowCount?: number
    matchedCount?: number
    unmatchedCount?: number
    errorMessage?: string
    metadata?: Json
  },
): Promise<void> {
  const updatePayload: ProjectionSyncRunUpdate = {
    completed_at: new Date().toISOString(),
    status: update.status,
    http_status: update.httpStatus ?? null,
    row_count: update.rowCount ?? 0,
    matched_count: update.matchedCount ?? 0,
    unmatched_count: update.unmatchedCount ?? 0,
    error_message: update.errorMessage ?? null,
    source_metadata: update.metadata ?? {},
  }

  const { error } = await supabase
    .from('projection_sync_runs')
    .update(updatePayload)
    .eq('id', runId)
  if (error) throw error
}

async function insertProjectionRows(rows: FantasyProsProjectionInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from('fantasypros_projection_rows').insert(rows.slice(i, i + CHUNK))
    if (error) throw error
  }
}

async function fetchPlayersForProjection(): Promise<PlayerForProjection[]> {
  const players: PlayerForProjection[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, display_name, nba_team, status')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    players.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return players
}

async function syncInternalFallbackProjections(
  seasonYear: number,
  weekNumber: number | null,
): Promise<number> {
  if (!weekNumber) {
    console.log('[sync-projections] No current regular-season week found for internal fallback.')
    return 0
  }

  const minWeek = Math.max(1, weekNumber - (LOOKBACK_WEEKS - 1))
  const rows: InternalFallbackStatRow[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('player_game_stats')
      .select(
        'player_id, points, rebounds, assists, steals, blocks, turnovers, ' +
          'three_pointers_made, field_goals_made, field_goals_attempted, ' +
          'free_throws_made, free_throws_attempted, double_double, triple_double, ' +
          'minutes_played, did_not_play, nba_games!inner(nba_game_id)',
      )
      .eq('season_year', seasonYear)
      .gte('week_number', minWeek)
      .lte('week_number', weekNumber)
      .like('nba_games.nba_game_id', '002%')
      .order('player_id', { ascending: true })
      .order('game_id', { ascending: true })
      .range(from, from + PAGE - 1)
      .returns<InternalFallbackStatRow[]>()
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  if (!rows.length) {
    console.log('[sync-projections] No recent stats found for internal fallback.')
    return 0
  }

  const playerGames = new Map<string, InternalFallbackStatRow[]>()
  for (const stat of rows) {
    if (stat.did_not_play) continue
    if (!playerGames.has(stat.player_id)) playerGames.set(stat.player_id, [])
    playerGames.get(stat.player_id)!.push(stat)
  }

  const projections: InternalProjectionUpsert[] = []
  const fetchedAt = new Date().toISOString()
  for (const [playerId, games] of playerGames) {
    if (!games.length) continue
    projections.push({
      player_id: playerId,
      season_year: seasonYear,
      week_number: weekNumber,
      projected_stat_points: averageStat(games, 'points'),
      projected_rebounds: averageStat(games, 'rebounds'),
      projected_assists: averageStat(games, 'assists'),
      projected_steals: averageStat(games, 'steals'),
      projected_blocks: averageStat(games, 'blocks'),
      projected_three_pointers_made: averageStat(games, 'three_pointers_made'),
      projected_turnovers: averageStat(games, 'turnovers'),
      projected_field_goals_made: averageStat(games, 'field_goals_made'),
      projected_field_goals_attempted: averageStat(games, 'field_goals_attempted'),
      projected_free_throws_made: averageStat(games, 'free_throws_made'),
      projected_free_throws_attempted: averageStat(games, 'free_throws_attempted'),
      projected_double_doubles: averageFlag(games, 'double_double'),
      projected_triple_doubles: averageFlag(games, 'triple_double'),
      projected_minutes: averageStat(games, 'minutes_played'),
      fetched_at: fetchedAt,
    })
  }

  for (let i = 0; i < projections.length; i += CHUNK) {
    const { error } = await supabase
      .from('player_projections')
      .upsert(projections.slice(i, i + CHUNK), { onConflict: 'player_id,season_year,week_number' })
    if (error) throw error
  }

  console.log(`[sync-projections] Upserted ${projections.length} internal fallback projections for week ${weekNumber}.`)
  return projections.length
}

function averageStat(
  games: InternalFallbackStatRow[],
  key: keyof Pick<
    InternalFallbackStatRow,
    | 'points'
    | 'rebounds'
    | 'assists'
    | 'steals'
    | 'blocks'
    | 'turnovers'
    | 'three_pointers_made'
    | 'field_goals_made'
    | 'field_goals_attempted'
    | 'free_throws_made'
    | 'free_throws_attempted'
    | 'minutes_played'
  >,
): number {
  const total = games.reduce((sum, game) => sum + Number(game[key] ?? 0), 0)
  return parseFloat((total / games.length).toFixed(2))
}

function averageFlag(
  games: InternalFallbackStatRow[],
  key: keyof Pick<InternalFallbackStatRow, 'double_double' | 'triple_double'>,
): number {
  const total = games.reduce((sum, game) => sum + (game[key] ? 1 : 0), 0)
  return parseFloat((total / games.length).toFixed(2))
}

async function getCurrentRegularSeasonWeekNumber(date: Date, seasonYear: number): Promise<number | null> {
  const dateISO = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const { data: week, error: weekError } = await supabase
    .from('season_weeks')
    .select('week_number')
    .eq('season_year', seasonYear)
    .lte('week_start', dateISO)
    .gte('week_end', dateISO)
    .maybeSingle()
  if (weekError) throw weekError
  if (!week) return null

  const { data: game, error: gameError } = await supabase
    .from('nba_games')
    .select('id')
    .eq('season_year', seasonYear)
    .eq('week_number', week.week_number)
    .like('nba_game_id', '002%')
    .limit(1)
    .maybeSingle()
  if (gameError) throw gameError

  return game ? week.week_number : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
