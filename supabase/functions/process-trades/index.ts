import type { Database } from '../_shared/database.ts'
import { notifyMembers } from '../_shared/notifications.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import { partitionTradeResults, tradeFailureMessage } from './results.ts'
import { notifyCompletedTrades, notifyExpiredTrades } from './notifications.ts'

const PROCESS_BATCH_LIMIT = 50

type ProcessedTradeRow = Database['public']['Functions']['process_due_accepted_trades_atomic']['Returns'][number]
type ExpiredTradeRow = {
  trade_id: string
  proposer_member_id: string
  recipient_member_id: string
  participant_member_ids: string[]
}

serveInternal('process-trades', async () => {
  const result = await processAcceptedTrades()
  return Response.json({ ok: true, ...result })
})

async function processAcceptedTrades(): Promise<{ processed: number; failed: number; failures: string[] }> {
  const expired = await expirePendingTrades()
  await notifyExpiredTradeResults(expired)

  const { data, error } = await supabase.rpc('process_due_accepted_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error

  const results: ProcessedTradeRow[] = data ?? []
  const partitioned = partitionTradeResults(results)

  await notifyCompletedTrades(partitioned.completed, notifyMembers)

  if (partitioned.retryableFailures.length > 0) {
    throw new Error(`Retryable trade processing failures: ${partitioned.retryableFailures.map(tradeFailureMessage).join('; ')}`)
  }

  return {
    processed: partitioned.completed.length,
    failed: partitioned.terminalFailures.length,
    failures: partitioned.terminalFailures.map(tradeFailureMessage),
  }
}

async function expirePendingTrades(): Promise<ExpiredTradeRow[]> {
  const { data, error } = await supabase.rpc('expire_pending_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error
  return data ?? []
}

async function notifyExpiredTradeResults(rows: ExpiredTradeRow[]): Promise<void> {
  if (rows.length === 0) return
  await notifyExpiredTrades(rows, notifyMembers)
}
