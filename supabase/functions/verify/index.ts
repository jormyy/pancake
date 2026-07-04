/**
 * verify — health checks and data validation.
 *
 * GET /verify?action=validate-db[&seasonYear=2026]
 * GET /verify?action=season-totals[&seasonYear=2026]
 * POST /verify { action: "test-endpoints" }
 */
import { supabase } from '../_shared/supabase.ts'
import { fetchTodaysGames, fetchBoxScore, fetchSeasonSchedule } from '../_shared/nba.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { serveInternal } from '../_shared/serve.ts'
import { errorMessage } from '../_shared/responses.ts'

serveInternal('verify', async (req) => {
  const url = new URL(req.url)
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const action = url.searchParams.get('action') ?? body.action
  const seasonYearParam = url.searchParams.get('seasonYear') ?? body.seasonYear
  const seasonYear = seasonYearParam ? parseInt(seasonYearParam) : currentSeasonYear()

  if (action === '__edge_auth_probe__') {
    return Response.json({ ok: true, action })
  }

  if (action === 'test-endpoints') {
    const results = await testNBAEndpoints()
    return Response.json({ ok: true, results })
  }

  if (action === 'season-totals') {
    const rows = await verifySeasonTotals(seasonYear)
    return Response.json({ ok: true, seasonYear, rows })
  }

  if (action === 'validate-db') {
    const report = await validateDatabase(seasonYear)
    return Response.json({ ok: true, ...report })
  }

  return Response.json({ ok: false, error: 'Unknown action. Use: test-endpoints, season-totals, validate-db' }, { status: 400 })
})

async function testNBAEndpoints() {
  const tests = [
    { name: 'todaysScoreboard', fn: () => fetchTodaysGames() },
    { name: 'seasonSchedule', fn: () => fetchSeasonSchedule() },
    { name: 'sampleBoxScore', fn: () => fetchBoxScore('0022500001') },
  ]

  const results = []
  for (const test of tests) {
    const start = Date.now()
    try {
      const data = await test.fn()
      results.push({ name: test.name, ok: true, ms: Date.now() - start, count: Array.isArray(data) ? data.length : 1 })
    } catch (e) {
      results.push({ name: test.name, ok: false, ms: Date.now() - start, error: errorMessage(e) })
    }
  }
  return results
}

async function verifySeasonTotals(seasonYear: number) {
  // Paginate player_game_stats to avoid PostgREST's 1000-row cap.
  // A full season has ~25K rows, so a single SELECT silently truncates.
  const PAGE = 1000
  const totals = new Map<string, { pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; gp: number }>()
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('player_game_stats')
      .select('player_id, points, rebounds, assists, steals, blocks, three_pointers_made')
      .eq('season_year', seasonYear)
      .eq('did_not_play', false)
      .range(from, from + PAGE - 1)

    if (error) throw error
    if (!data || data.length === 0) break

    for (const s of data) {
      const t = totals.get(s.player_id) ?? { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, gp: 0 }
      t.pts += s.points ?? 0
      t.reb += s.rebounds ?? 0
      t.ast += s.assists ?? 0
      t.stl += s.steals ?? 0
      t.blk += s.blocks ?? 0
      t.tpm += s.three_pointers_made ?? 0
      t.gp++
      totals.set(s.player_id, t)
    }

    if (data.length < PAGE) break
    from += PAGE
  }

  // Get player names — paginate in case players table exceeds 1000 rows.
  const nameMap = new Map<string, string>()
  let pFrom = 0
  while (true) {
    const { data: players, error: pErr } = await supabase
      .from('players')
      .select('id, display_name')
      .range(pFrom, pFrom + PAGE - 1)

    if (pErr) throw pErr
    if (!players || players.length === 0) break

    for (const p of players as Array<{ id: string; display_name: string | null }>) {
      nameMap.set(p.id, p.display_name ?? p.id)
    }

    if (players.length < PAGE) break
    pFrom += PAGE
  }

  return [...totals.entries()]
    .map(([id, t]) => ({ player: nameMap.get(id) ?? id, gp: t.gp, pts: t.pts, reb: t.reb, ast: t.ast, stl: t.stl, blk: t.blk, tpm: t.tpm }))
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 20)
}

async function validateDatabase(seasonYear: number) {
  const { count: totalGames } = await supabase
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)

  const { count: finalGames } = await supabase
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)
    .eq('status', 'Final')

  // Use a raw SQL count to avoid PostgREST's 1000-row default limit
  const { data: missingStatsRow } = await supabase
    .rpc('count_final_games_missing_stats', { season_year_param: seasonYear })
  const gamesWithStats = missingStatsRow ?? 0

  const { count: missingNbaGameId } = await supabase
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)
    .is('nba_game_id', null)

  const { count: playersWithoutNbaId } = await supabase
    .from('players')
    .select('id', { count: 'exact', head: true })
    .is('nba_id', null)

  return {
    seasonYear,
    totalGames,
    finalGames,
    finalGamesWithoutStats: Number(gamesWithStats),
    gamesMissingNbaGameId: missingNbaGameId,
    playersWithoutNbaId,
  }
}
