import { supabase } from '../_shared/supabase.ts'
import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { errorMessage } from '../_shared/responses.ts'
import { processManualRestOfSeason } from './run.ts'

export type RefillRequest = {
  member_id: string
  league_id: string
  league_season_id: string
  requested_at: string
}

export type RefillOutcome = { refilled: number; failed: number; errors: string[] }

async function refillMember(request: RefillRequest): Promise<number> {
  const result = await processManualRestOfSeason({
    mode: 'rest_of_season',
    leagueId: request.league_id,
    leagueSeasonId: request.league_season_id,
    memberId: request.member_id,
  })
  return result.failed
}

export async function processRosterRefill(
  refill: (request: RefillRequest) => Promise<number> = refillMember,
): Promise<RefillOutcome> {
  const outcome: RefillOutcome = { refilled: 0, failed: 0, errors: [] }
  await renewCurrentWorkLease()
  const { data, error } = await supabase.rpc('claim_lineup_refills', { p_limit: 1 })
  if (error) throw error
  const request = (data ?? [])[0] as RefillRequest | undefined
  if (!request) return outcome
  try {
    const failedDates = await refill(request)
    if (failedDates > 0) {
      outcome.failed++
      outcome.errors.push(`${request.member_id}: ${failedDates} date(s) failed`)
    } else {
      outcome.refilled++
    }
  } catch (refillError) {
    outcome.failed++
    outcome.errors.push(`${request.member_id}: ${errorMessage(refillError)}`)
  }
  const { error: completeError } = await supabase.rpc('complete_lineup_refill', {
    p_member_id: request.member_id,
    p_requested_at: request.requested_at,
  })
  if (completeError) throw completeError
  return outcome
}
