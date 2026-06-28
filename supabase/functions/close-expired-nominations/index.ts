import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'
import { supabase } from '../_shared/supabase.ts'

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
  const { data: expired, error: expiredError } = await supabase
    .from('nominations')
    .select('id')
    .eq('status', 'open')
    .lt('countdown_expires_at', new Date().toISOString())
  if (expiredError) throw expiredError

  if (!expired || expired.length === 0) return { checked: 0, closed: 0, failed: 0 }

  let closed = 0
  let failed = 0
  const results = await Promise.allSettled(
    expired.map(async (nomination) => {
      const { data, error } = await supabase.rpc('close_auction_nomination_atomic', {
        p_nomination_id: nomination.id,
      })
      if (error) throw error
      return Boolean(data)
    }),
  )

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]
    if (result.status === 'fulfilled') {
      if (result.value) closed += 1
      continue
    }
    failed += 1
    console.error(`[close-expired-nominations] nomination ${expired[i].id} failed`, result.reason)
  }

  return { checked: expired.length, closed, failed }
}
