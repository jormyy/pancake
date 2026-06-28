import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { notifyMember } from '../_shared/notifications.ts'
import { internalServerError } from '../_shared/responses.ts'
import { supabase } from '../_shared/supabase.ts'

const TERMINAL_COMPLETION_ERROR_FRAGMENTS = [
  'Player asset is no longer owned by the expected trade side',
  'Player asset is no longer owned by the expected active roster side',
  'Draft-pick asset is no longer owned by the expected trade side',
  'Reserved drop player is no longer on the expected roster',
  'Failed to move player asset atomically',
  'Failed to move draft-pick asset atomically',
  'Trade completion would overfill a roster',
  'This roster player is reserved for an accepted trade',
  'Inactive roster players must be activated before they can be traded',
  'Trade player assets must be active and unreserved roster players',
]

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    const result = await processAcceptedTrades()
    return Response.json({ ok: true, ...result })
  } catch (error) {
    return internalServerError('process-trades', error)
  }
})

async function processAcceptedTrades(): Promise<{ processed: number; failed: number; failures: string[] }> {
  const { data: trades, error } = await supabase
    .from('trades')
    .select('id, proposer_member_id, recipient_member_id, league_seasons!inner(is_current, leagues!inner(status))')
    .eq('status', 'accepted')
    .lte('veto_window_expires_at', new Date().toISOString())
    .eq('league_seasons.is_current', true)
    .in('league_seasons.leagues.status', ['active', 'playoffs'])

  if (error) throw error

  let processed = 0
  let failed = 0
  const failures: string[] = []

  const results = await Promise.allSettled(
    (trades ?? []).map((trade) =>
      supabase
        .rpc('complete_accepted_trade_atomic', { p_trade_id: trade.id })
        .then((res) => ({
          tradeId: trade.id,
          proposerMemberId: trade.proposer_member_id,
          recipientMemberId: trade.recipient_member_id,
          error: res.error,
        }))),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      failed += 1
      failures.push(`Trade <unknown>: ${result.reason?.message ?? String(result.reason)}`)
      continue
    }

    if (result.value.error) {
      const message = result.value.error.message
      if (isTerminalCompletionError(message)) {
        const { error: expireError } = await supabase.rpc('expire_trade_completion_failure_atomic', {
          p_trade_id: result.value.tradeId,
          p_reason: message,
        })

        failed += 1
        failures.push(
          expireError
            ? `Trade ${result.value.tradeId}: completion failed (${message}); terminalization failed: ${expireError.message}`
            : `Trade ${result.value.tradeId}: expired after deterministic completion drift: ${message}`,
        )
        continue
      }

      failed += 1
      failures.push(`Trade ${result.value.tradeId}: ${message}`)
      continue
    }

    processed += 1
    await Promise.all([
      notifyMember(
        result.value.proposerMemberId,
        'Trade Completed',
        'Assets have moved. Check your roster.',
        { tradeId: result.value.tradeId },
      ),
      notifyMember(
        result.value.recipientMemberId,
        'Trade Completed',
        'Assets have moved. Check your roster.',
        { tradeId: result.value.tradeId },
      ),
    ]).catch((notifyError) => console.error('[process-trades] notification failed', notifyError))
  }

  return { processed, failed, failures }
}

function isTerminalCompletionError(message: string): boolean {
  return TERMINAL_COMPLETION_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment))
}
