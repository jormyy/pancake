import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { supabase } from '../_shared/supabase.ts'
import { DYNASTY_TRADE_MODEL_VERSION } from '../_shared/dynastyEngine.ts'
import { retryDatabaseContention } from '../_shared/databaseRetry.ts'

type RefreshClaim = {
  leagueId: string
  seasonId: string
  version: number
  claimToken: string
}

const retryRefresh = <T extends { error: unknown }>(run: () => PromiseLike<T>) =>
  retryDatabaseContention(run, { failures: result => result.error ? [result.error] : [] })

export async function refreshViews() {
  await renewCurrentWorkLease()
  const { data, error } = await retryRefresh(() => supabase.rpc('view_refresh_work', { p_params: { operation: 'claim', limit: 1 } }))
  if (error) throw error
  const claims = data as unknown as RefreshClaim[]
  let completed = 0
  const failures: string[] = []
  for (const claim of claims) {
    const params = { seasonId: claim.seasonId, version: claim.version, claimToken: claim.claimToken }
    try {
      await renewCurrentWorkLease()
      const { data: saved, error: saveError } = await retryRefresh(() => supabase.rpc('view_refresh_work', {
        p_league_id: claim.leagueId,
        p_params: { ...params, operation: 'complete', modelVersion: DYNASTY_TRADE_MODEL_VERSION },
      }))
      if (saveError) throw saveError
      if (saved) completed++
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error)
      failures.push(message)
      const { error: releaseError } = await retryRefresh(() => supabase.rpc('view_refresh_work', {
        p_league_id: claim.leagueId, p_params: { ...params, operation: 'fail', error: message },
      }))
      if (releaseError) failures.push(releaseError.message)
    }
  }
  return { result: { completed, failures }, rowsAffected: completed, failure: failures.length ? failures.join('\n') : null }
}
