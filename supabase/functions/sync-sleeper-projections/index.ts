import { supabase } from '../_shared/supabase.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { currentSeasonYear } from '../_shared/season.ts'
import { syncSleeperProjections } from './sync.ts'

serveInternal('sync-sleeper-projections', async (request) => {
  const result = await recordSyncRun('sync-sleeper-projections', async () => {
    const seasonYear = currentSeasonYear()
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    const { data: weeks, error } = await supabase.from('season_weeks').select('week_number,week_start,week_end')
      .eq('season_year', seasonYear).order('week_start')
    if (error) throw error
    const monday = (value: string) => {
      const day = new Date(`${value}T12:00:00Z`)
      day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7)
      return day.toISOString().slice(0, 10)
    }
    const weekStart = monday(date)
    const weekEnd = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10)
    const week = weeks.find((item) => monday(item.week_start) === weekStart)
    if (!week || !weeks.length) throw new Error('No current regular-season projection week')
    const sleeperWeek = Math.round((Date.parse(weekStart) - Date.parse(monday(weeks[0].week_start))) / (7 * 86400000)) + 1
    const result = await syncSleeperProjections(supabase, { seasonYear, weekNumber: week.week_number, sleeperWeek, weekStart, weekEnd }, fetchWithRetry)
    return { result, rowsAffected: result.rows }
  }, request)
  return Response.json({ ok: true, ...result })
})
