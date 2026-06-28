import { supabase } from '../_shared/supabase.ts'
import { calculateFantasyPoints, snakeToStatLine } from '../_shared/scoring.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'

const LOOKBACK_WEEKS = 4
const CHUNK = 500

const STD_SCORING: Record<string, number> = {
  points: 1, rebounds: 1.2, assists: 1.5,
  steals: 3, blocks: 3, turnovers: -1,
  three_pointers_made: 1,
  field_goals_made: 0, field_goals_attempted: 0,
  free_throws_made: 0, free_throws_attempted: 0,
}

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    await syncProjections()
    return Response.json({ ok: true })
  } catch (e: unknown) {
    return internalServerError('sync-projections', e)
  }
})

async function syncProjections() {
  const today = new Date()
  const seasonYear = currentSeasonYear()
  const weekNumber = await getCurrentRegularSeasonWeekNumber(today, seasonYear)

  if (!weekNumber) {
    console.log('[sync-projections] No current regular-season week found, skipping.')
    return
  }

  const minWeek = Math.max(1, weekNumber - (LOOKBACK_WEEKS - 1))

  // Paginate to avoid PostgREST max_rows cap (~1000 rows by default).
  // With ~500 active players * ~3 games/week * 4 weeks this exceeds the cap.
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

  if (!rows.length) { console.log('[sync-projections] No recent stats found.'); return }

  const playerGames = new Map<string, any[]>()
  for (const s of rows) {
    if (s.did_not_play) continue
    if (!playerGames.has(s.player_id)) playerGames.set(s.player_id, [])
    playerGames.get(s.player_id)!.push(s)
  }

  const projections: any[] = []
  for (const [playerId, games] of playerGames) {
    if (!games.length) continue
    const avg = games.reduce((sum, g) => sum + calculateFantasyPoints(snakeToStatLine(g), STD_SCORING), 0) / games.length
    projections.push({
      player_id: playerId,
      season_year: seasonYear,
      week_number: weekNumber,
      projected_points: parseFloat(avg.toFixed(2)),
      fetched_at: new Date().toISOString(),
    })
  }

  if (!projections.length) return

  for (let i = 0; i < projections.length; i += CHUNK) {
    const { error: upErr } = await supabase
      .from('player_projections')
      .upsert(projections.slice(i, i + CHUNK), { onConflict: 'player_id,season_year,week_number' })
    if (upErr) throw upErr
  }

  console.log(`[sync-projections] Upserted ${projections.length} projections for week ${weekNumber}.`)
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
