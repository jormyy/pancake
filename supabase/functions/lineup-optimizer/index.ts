import { processDaily } from './daily.ts'
import { processPreTipoff } from './preTipoff.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { parseManualDateFilter } from './manual.ts'
import { processEnabledLineupOptimizers, processManualRestOfSeason, type ManualRequest } from './run.ts'

serveInternal('lineup-optimizer', async (req) => {
  const body: Record<string, unknown> = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  if (body.mode === 'daily') {
    const result = await recordSyncRun('lineup-optimizer', async () => {
      const outcome = await processDaily(body)
      return { result: outcome, rowsAffected: outcome.optimized, failure: outcome.failed ? outcome.errors.join('\n') : null }
    }, req)
    return Response.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 500 : 200 })
  }
  if (body.mode === 'pre_tipoff') {
    const { batchFailed, ...result } = await recordSyncRun('lineup-optimizer', async () => {
      const outcome = await processPreTipoff(body)
      return { result: outcome, rowsAffected: outcome.optimized, failure: outcome.batchFailed ? outcome.errors.join('\n') : null }
    }, req)
    return Response.json({ ok: !batchFailed, ...result }, { status: batchFailed ? 500 : 200 })
  }
  const manual = manualRequest(body)
  if (manual) {
    return Response.json({ ok: true, ...await processManualRestOfSeason(manual) })
  }
  const requestedDate = typeof body.date === 'string' ? body.date : null
  // Per-member failures are isolated (one throwing member must not stall the
  // rest) but they must still reach monitoring: the run is recorded as failed
  // in sync_runs with a summary whenever any member failed.
  const result = await recordSyncRun('lineup-optimizer', async () => {
    const outcome = await processEnabledLineupOptimizers(requestedDate)
    return {
      result: outcome,
      rowsAffected: outcome.optimized,
      failure: outcome.failed > 0
        ? `${outcome.failed} of ${outcome.settings} enabled member(s) failed auto-set (see function logs)`
        : null,
    }
  }, req)
  return Response.json({ ok: true, ...result })
})

function manualRequest(body: Record<string, unknown>): ManualRequest | null {
  if (body.mode !== 'rest_of_season') return null
  for (const key of ['leagueId', 'leagueSeasonId', 'memberId'] as const) {
    if (typeof body[key] !== 'string' || !body[key]) throw new TypeError(`${key} is required`)
  }
  return {
    mode: 'rest_of_season',
    dates: parseManualDateFilter(body.dates),
    leagueId: body.leagueId as string,
    leagueSeasonId: body.leagueSeasonId as string,
    memberId: body.memberId as string,
  }
}
