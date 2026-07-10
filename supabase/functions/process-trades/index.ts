import type { Database } from '../_shared/database.ts'
import { notifyMembers } from '../_shared/notifications.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import { partitionTradeResults, tradeFailureMessage } from './results.ts'
import { notifyCompletedTrades, notifyExpiredTrades } from './notifications.ts'
import { deliverTradeNotificationOutbox } from './outbox.ts'

const PROCESS_BATCH_LIMIT = 50
const OUTBOX_BATCH_LIMIT = 200

type ProcessedTradeRow = Database['public']['Functions']['process_due_accepted_trades_atomic']['Returns'][number]
type ExpiredTradeRow = {
  trade_id: string
  proposer_member_id: string
  recipient_member_id: string
  participant_member_ids: string[]
}
type OutboxRow = Database['public']['Functions']['claim_notification_outbox_atomic']['Returns'][number]

serveInternal('process-trades', async () => {
  const result = await processAcceptedTrades()
  return Response.json({ ok: true, ...result })
})

async function processAcceptedTrades(): Promise<{
  processed: number
  failed: number
  failures: string[]
  notificationsDelivered: number
  notificationsDeferred: number
}> {
  const expired = await expirePendingTrades()

  const { data, error } = await supabase.rpc('process_due_accepted_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error

  const results: ProcessedTradeRow[] = data ?? []
  const partitioned = partitionTradeResults(results)
  const notificationResult = await drainNotificationOutbox()

  await notifyExpiredTradeResults(expired)
  await notifyCompletedTrades(partitioned.completed, notifyMembers)

  if (partitioned.retryableFailures.length > 0) {
    throw new Error(`Retryable trade processing failures: ${partitioned.retryableFailures.map(tradeFailureMessage).join('; ')}`)
  }

  return {
    processed: partitioned.completed.length,
    failed: partitioned.terminalFailures.length,
    failures: partitioned.terminalFailures.map(tradeFailureMessage),
    notificationsDelivered: notificationResult.delivered,
    notificationsDeferred: notificationResult.failed,
  }
}

async function drainNotificationOutbox(): Promise<{ delivered: number; failed: number }> {
  const { data, error } = await supabase.rpc('claim_notification_outbox_atomic', {
    p_limit: OUTBOX_BATCH_LIMIT,
    p_lease_seconds: 60,
  })
  if (error) throw error
  const rows: OutboxRow[] = data ?? []

  return deliverTradeNotificationOutbox(
    rows,
    notifyMembers,
    async (row) => {
      const { data: completed, error: completeError } = await supabase.rpc('complete_notification_outbox_atomic', {
        p_id: row.id,
        p_claim_token: row.claim_token,
      })
      if (completeError) throw completeError
      if (!completed) throw new Error(`Notification outbox lease ${row.id} was lost before acknowledgement`)
    },
    async (row, deliveryError) => {
      const { data: failed, error: failError } = await supabase.rpc('fail_notification_outbox_atomic', {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: deliveryError,
      })
      if (failError) throw failError
      if (!failed) throw new Error(`Notification outbox lease ${row.id} was lost before retry scheduling`)
    },
  )
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
