import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import type { Database } from '../_shared/database.ts'
import { notifyMember } from '../_shared/notifications.ts'
import { internalServerError } from '../_shared/responses.ts'
import { supabase } from '../_shared/supabase.ts'

const PROCESS_BATCH_LIMIT = 50

type ProcessedTradeRow = Database['public']['Functions']['process_due_accepted_trades_atomic']['Returns'][number]
type ExpiredTradeRow = {
  trade_id: string
  proposer_member_id: string
  recipient_member_id: string
}

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
  const expired = await expirePendingTrades()
  await notifyExpiredTrades(expired)

  const { data, error } = await supabase.rpc('process_due_accepted_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error

  let processed = 0
  let failed = 0
  const failures: string[] = []
  const results: ProcessedTradeRow[] = data ?? []

  for (const result of results) {
    if (result.status !== 'completed') {
      failed += 1
      const message = result.error_message ?? result.error_code ?? result.status
      failures.push(`Trade ${result.trade_id}: ${result.status}: ${message}`)
      continue
    }

    processed += 1
    await Promise.all([
      notifyMember(
        result.proposer_member_id,
        'Trade Completed',
        'Assets have moved. Check your roster.',
        { tradeId: result.trade_id },
        'trade',
      ),
      notifyMember(
        result.recipient_member_id,
        'Trade Completed',
        'Assets have moved. Check your roster.',
        { tradeId: result.trade_id },
        'trade',
      ),
    ]).catch((notifyError) => console.error('[process-trades] notification failed', notifyError))
  }

  return { processed, failed, failures }
}

async function expirePendingTrades(): Promise<ExpiredTradeRow[]> {
  const { data, error } = await supabase.rpc('expire_pending_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error
  return data ?? []
}

async function notifyExpiredTrades(rows: ExpiredTradeRow[]): Promise<void> {
  if (rows.length === 0) return
  await Promise.all(rows.flatMap((row) => [
    notifyMember(
      row.proposer_member_id,
      'Trade Expired',
      'One of your pending trade offers expired.',
      { tradeId: row.trade_id },
      'trade',
    ),
    notifyMember(
      row.recipient_member_id,
      'Trade Expired',
      'A pending trade offer expired.',
      { tradeId: row.trade_id },
      'trade',
    ),
  ])).catch((notifyError) => console.error('[process-trades] expiration notification failed', notifyError))
}
