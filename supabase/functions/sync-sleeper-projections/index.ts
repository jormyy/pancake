import { supabase } from '../_shared/supabase.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { resolveProjectionWeek, syncSleeperProjections } from './sync.ts'

type SleeperRunResult = Awaited<ReturnType<typeof syncSleeperProjections>> | { skipped: true; reason: string; date: string }

serveInternal('sync-sleeper-projections', async (request) => {
  const result = await recordSyncRun<SleeperRunResult>('sync-sleeper-projections', async () => {
    const seasonYear = currentSeasonYear()
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    const { data: weeks, error } = await supabase.from('season_weeks').select('week_number,week_start,week_end')
      .eq('season_year', seasonYear).order('week_start')
    if (error) throw error
    const week = resolveProjectionWeek(weeks, date)
    if (!week) return { result: { skipped: true, reason: 'No current regular-season projection week', date }, rowsAffected: 0 }
    const result = await syncSleeperProjections(supabase, { seasonYear, ...week }, fetchWithRetry)
    return { result, rowsAffected: result.rows }
  }, request)
  return Response.json({ ok: true, ...result })
})
