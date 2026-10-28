import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { supabase } from '../_shared/supabase.ts'
import { revalueTrade } from '../api/tradeEstimates.ts'
import type { Json } from '../_shared/database.ts'

type RefreshClaim = {
  leagueId: string
  seasonId: string
  version: number
  claimToken: string
  trades: { tradeId: string; memberId: string; userId: string }[]
}

export async function refreshViews() {
  await renewCurrentWorkLease()
  const { data, error } = await supabase.rpc('view_refresh_work', { p_params: { operation: 'claim', limit: 5 } })
  if (error) throw error
  const claims = data as unknown as RefreshClaim[]
  let completed = 0
  const failures: string[] = []
  for (const claim of claims) {
    const params = { seasonId: claim.seasonId, version: claim.version, claimToken: claim.claimToken }
    try {
      const tradeValues: { tradeId: string; revaluation: unknown }[] = []
      for (const trade of claim.trades) {
        await renewCurrentWorkLease()
        try {
          tradeValues.push({ tradeId: trade.tradeId, revaluation: await revalueTrade(trade.userId, trade.memberId, trade.tradeId) })
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || !['22023', '42501'].includes(String(error.code))) throw error
          tradeValues.push({ tradeId: trade.tradeId, revaluation: { tradeId: trade.tradeId, unavailableReason: error.message } })
        }
      }
      await renewCurrentWorkLease()
      const { data: saved, error: saveError } = await supabase.rpc('view_refresh_work', {
        p_league_id: claim.leagueId,
        p_params: { ...params, operation: 'complete', tradeValues } as unknown as Json,
      })
      if (saveError) throw saveError
      if (saved) completed++
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error)
      failures.push(message)
      const { error: releaseError } = await supabase.rpc('view_refresh_work', {
        p_league_id: claim.leagueId, p_params: { ...params, operation: 'fail', error: message },
      })
      if (releaseError) failures.push(releaseError.message)
    }
  }
  return { result: { completed, failures }, rowsAffected: completed, failure: failures.length ? failures.join('\n') : null }
}
