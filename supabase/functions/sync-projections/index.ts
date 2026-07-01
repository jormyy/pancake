import { supabase } from '../_shared/supabase.ts'
import { calculateFantasyPoints, snakeToStatLine } from '../_shared/scoring.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
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

const STD_SCORING: Record<string, number> = {
  points: 1,
  rebounds: 1.2,
  assists: 1.5,
  steals: 3,
  blocks: 3,
  turnovers: -1,
  three_pointers_made: 1,
  field_goals_made: 0,
  field_goals_attempted: 0,
  free_throws_made: 0,
  free_throws_attempted: 0,
}

type SourceResult = {
  projectionType: FantasyProsProjectionType
  status: 'success' | 'failed'
  rows: number
  matched: number
  unmatched: number
  error?: string
}

type UntypedSupabase = typeof supabase & {
  from: (table: string) => any
  rpc: (fn: string, args?: Record<string, unknown>) => any
}

const db = supabase as UntypedSupabase

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const result = await syncProjections()
    return Response.json({ ok: true, ...result })
  } catch (e: unknown) {
    return internalServerError('sync-projections', e)
  }
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
    if (!response.ok) throw new Error(`FantasyPros ${projectionType} fetch failed with HTTP ${response.status}`)

    const parsedRows = parseFantasyProsProjectionHtml(html)
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
    console.warn(`[sync-projections] FantasyPros ${projectionType} failed: ${message}`)
    await finishSyncRun(run.id, {
      status: 'failed',
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
  const { data, error } = await db
    .from('projection_sync_runs')
    .insert({
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
    })
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
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await db
    .from('projection_sync_runs')
    .update({
      completed_at: new Date().toISOString(),
      status: update.status,
      http_status: update.httpStatus ?? null,
      row_count: update.rowCount ?? 0,
      matched_count: update.matchedCount ?? 0,
      unmatched_count: update.unmatchedCount ?? 0,
      error_message: update.errorMessage ?? null,
      source_metadata: update.metadata ?? {},
    })
    .eq('id', runId)
  if (error) throw error
}

async function insertProjectionRows(rows: FantasyProsProjectionInsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('fantasypros_projection_rows').insert(rows.slice(i, i + CHUNK))
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
  const rows: any[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('player_game_stats')
      .select(
        'player_id, points, rebounds, assists, steals, blocks, turnovers, ' +
          'three_pointers_made, field_goals_made, field_goals_attempted, ' +
          'free_throws_made, free_throws_attempted, did_not_play, nba_games!inner(nba_game_id)',
      )
      .eq('season_year', seasonYear)
      .gte('week_number', minWeek)
      .lte('week_number', weekNumber)
      .like('nba_games.nba_game_id', '002%')
      .range(from, from + PAGE - 1)
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

  const playerGames = new Map<string, any[]>()
  for (const stat of rows) {
    if (stat.did_not_play) continue
    if (!playerGames.has(stat.player_id)) playerGames.set(stat.player_id, [])
    playerGames.get(stat.player_id)!.push(stat)
  }

  const projections: any[] = []
  for (const [playerId, games] of playerGames) {
    if (!games.length) continue
    const avg =
      games.reduce((sum, game) => sum + calculateFantasyPoints(snakeToStatLine(game), STD_SCORING), 0) /
      games.length
    projections.push({
      player_id: playerId,
      season_year: seasonYear,
      week_number: weekNumber,
      projected_points: parseFloat(avg.toFixed(2)),
      fetched_at: new Date().toISOString(),
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
