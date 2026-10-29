import { supabase } from '../_shared/supabase.ts'
import { fetchSeasonSchedule } from '../_shared/nba.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { buildScheduleSyncPlan } from '../_shared/schedule.ts'
import { renewCurrentWorkLease } from '../_shared/workContext.ts'


serveInternal('sync-schedule', async (req) => {
  const result = await recordSyncRun('sync-schedule', async () => {
    const result = await syncSchedule()
    return { result, rowsAffected: result.games + result.weeks }
  }, req)
  return Response.json({ ok: true, ...result })
})

async function syncSchedule(): Promise<{ games: number; weeks: number }> {
  console.log('[sync-schedule] Fetching schedule from NBA CDN...')
  const raw = await fetchSeasonSchedule()
  if (!raw.length) { console.log('[sync-schedule] No schedule data.'); return { games: 0, weeks: 0 } }

  const plan = buildScheduleSyncPlan(raw, new Date(), true)
  if (plan.offseasonStale) {
    console.log('[sync-schedule] Offseason: CDN still serves last season; skipping until the new schedule is published.')
    return { games: 0, weeks: 0 }
  }
  if (!plan.regularSeason.length) { console.log('[sync-schedule] No regular season games.'); return { games: 0, weeks: 0 } }
  if (!plan.seasonStart) { console.log('[sync-schedule] No regular season start date.'); return { games: 0, weeks: 0 } }
  if (!plan.rows.length) { console.log('[sync-schedule] No schedule rows.'); return { games: 0, weeks: 0 } }

  const weeks = await publishSchedule(plan)

  console.log(`[sync-schedule] ${plan.rows.length} games published, ${weeks} weeks changed.`)
  return { games: plan.rows.length, weeks }
}

async function publishSchedule(plan: ReturnType<typeof buildScheduleSyncPlan>): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase.rpc('publish_nba_schedule_atomic', {
      p_season_year: plan.seasonYear!, p_games: plan.rows, p_weeks: plan.weeks,
    })
    if (!error) return data
    if (attempt === 2 || !['PT409', '55P03', '40P01', '40001', '57014'].includes(error.code)) throw error
    await renewCurrentWorkLease()
    await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt))
    await renewCurrentWorkLease()
  }
  throw new Error('Schedule publication retry budget exhausted')
}
