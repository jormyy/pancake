import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import type { Database } from '../_shared/database.ts'
import { internalServerError } from '../_shared/responses.ts'
import { supabase } from '../_shared/supabase.ts'

const CLOSE_BATCH_LIMIT = 100

type ClosedNominationRow = Database['public']['Functions']['close_expired_auction_nominations_atomic']['Returns'][number]

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const result = await closeExpiredNominations()
    return Response.json({ ok: true, ...result })
  } catch (error) {
    return internalServerError('close-expired-nominations', error)
  }
})

async function closeExpiredNominations(): Promise<{ checked: number; closed: number; failed: number }> {
  const { data, error } = await supabase.rpc('close_expired_auction_nominations_atomic', {
    p_limit: CLOSE_BATCH_LIMIT,
  })
  if (error) throw error

  let closed = 0
  let failed = 0
  const results: ClosedNominationRow[] = data ?? []

  for (const result of results) {
    if (!result.error_message && !result.error_code) {
      if (result.closed) closed += 1
      continue
    }
    failed += 1
    console.error(
      `[close-expired-nominations] nomination ${result.nomination_id} failed`,
      result.error_message ?? result.error_code,
    )
  }

  return { checked: results.length, closed, failed }
}
