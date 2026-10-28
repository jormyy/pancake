import { supabase } from '../_shared/supabase.ts'
import { serveInternal } from '../_shared/serve.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { computeForecast } from './compute.ts'
import { loadForecastContext } from './context.ts'
import type { Json } from '../_shared/database.ts'

serveInternal('matchup-forecast', async req => {
  const result = await recordSyncRun('matchup-forecast', async () => {
    const { data: claims, error } = await supabase.rpc('claim_matchup_forecasts', { p_limit: 10 })
    if (error) throw error
    let completed = 0
    const failures: string[] = []
    for (const claim of claims ?? []) {
      try {
        const input = await loadForecastContext(claim.matchup_id)
        const forecast = computeForecast(input)
        const now = Date.parse(input.observedAt)
        const nextTipoff = input.games.map(game => Date.parse(game.game_time ?? '')).filter(time => time > now).sort((a, b) => a - b)[0]
        const expires = Math.min(now + 6 * 60 * 60 * 1000, nextTipoff ?? Infinity)
        const { data: saved, error: saveError } = await supabase.rpc('complete_matchup_forecast', {
          p_matchup_id: claim.matchup_id, p_revision: claim.revision, p_claim_token: claim.claim_token,
          p_forecast: forecast as unknown as Json, p_valid_until: new Date(expires).toISOString(),
        })
        if (saveError) throw saveError
        if (saved) completed++
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error)
        failures.push(`${claim.matchup_id}: ${message}`)
        const { error: releaseError } = await supabase.rpc('fail_matchup_forecast', {
          p_matchup_id: claim.matchup_id, p_claim_token: claim.claim_token, p_error: message,
        })
        if (releaseError) failures.push(releaseError.message)
      }
    }
    return { result: { completed, failures }, rowsAffected: completed, failure: failures.length ? failures.join('\n') : null }
  }, req)
  return Response.json({ ok: result.failures.length === 0, ...result }, { status: result.failures.length ? 500 : 200 })
})
