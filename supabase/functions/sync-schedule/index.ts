import { supabase } from '../_shared/supabase.ts'
import { fetchSeasonSchedule } from '../_shared/nba.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import { buildScheduleSyncPlan, type ScheduleGameRow, type SeasonWeekRow } from '../_shared/schedule.ts'

const CHUNK = 500

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const result = await syncSchedule()
    return Response.json({ ok: true, ...result })
  } catch (e: unknown) {
    return internalServerError('sync-schedule', e)
  }
})

async function syncSchedule(): Promise<{ updated: number; inserted: number; weeks: number }> {
  console.log('[sync-schedule] Fetching schedule from NBA CDN...')
  const raw = await fetchSeasonSchedule()
  if (!raw.length) { console.log('[sync-schedule] No schedule data.'); return { updated: 0, inserted: 0, weeks: 0 } }

  const plan = buildScheduleSyncPlan(raw)
  if (!plan.regularSeason.length) { console.log('[sync-schedule] No regular season games.'); return { updated: 0, inserted: 0, weeks: 0 } }
  if (!plan.seasonStart) { console.log('[sync-schedule] No regular season start date.'); return { updated: 0, inserted: 0, weeks: 0 } }
  if (!plan.rows.length) { console.log('[sync-schedule] No schedule rows.'); return { updated: 0, inserted: 0, weeks: 0 } }

  // Paginate to avoid PostgREST max_rows cap (>1000 games across seasons)
  const existing: { id: string; game_date: string; home_team: string; away_team: string; nba_game_id: string | null }[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error: fetchErr } = await supabase
      .from('nba_games')
      .select('id, game_date, home_team, away_team, nba_game_id')
      .range(from, from + PAGE - 1)
    if (fetchErr) throw fetchErr
    if (!data || data.length === 0) break
    existing.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  const byNbaGameId = new Map<string, string>()
  const byDateTeams = new Map<string, string>()
  for (const g of existing) {
    if (g.nba_game_id) byNbaGameId.set(g.nba_game_id, g.id)
    byDateTeams.set(`${g.game_date}_${g.home_team}_${g.away_team}`, g.id)
  }

  const toUpdate: (ScheduleGameRow & { id: string })[] = []
  const toInsert: ScheduleGameRow[] = []

  for (const game of plan.rows) {
    const key = `${game.game_date}_${game.home_team}_${game.away_team}`
    const existingId = byNbaGameId.get(game.nba_game_id) ?? byDateTeams.get(key)
    if (existingId) {
      toUpdate.push({ id: existingId, ...game })
    } else {
      toInsert.push(game)
    }
  }

  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const { error } = await supabase
      .from('nba_games')
      .upsert(toUpdate.slice(i, i + CHUNK), { onConflict: 'id' })
    if (error) throw error
  }

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const { error } = await supabase
      .from('nba_games')
      .upsert(toInsert.slice(i, i + CHUNK), { onConflict: 'nba_game_id' })
    if (error) throw error
  }

  console.log(`[sync-schedule] ${toUpdate.length} updated, ${toInsert.length} inserted.`)
  const weeks = await syncSeasonWeeks(plan.weeks)
  return { updated: toUpdate.length, inserted: toInsert.length, weeks }
}

async function syncSeasonWeeks(weeks: SeasonWeekRow[]): Promise<number> {
  if (!weeks.length) return 0

  const { error } = await supabase
    .from('season_weeks')
    .upsert(weeks, { onConflict: 'season_year,week_number' })
  if (error) throw error
  console.log(`[sync-schedule] Upserted ${weeks.length} season weeks.`)
  return weeks.length
}
