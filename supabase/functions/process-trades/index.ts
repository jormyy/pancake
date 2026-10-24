import type { Database } from '../_shared/database.ts'
import { notifyMembers } from '../_shared/notifications.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import { partitionTradeResults, tradeFailureMessage } from './results.ts'
import {
  deliverTradeNotificationOutbox,
  drainTradeNotificationOutbox,
  OUTBOX_CLAIM_LIMIT,
  OUTBOX_LEASE_SECONDS,
} from './outbox.ts'

const PROCESS_BATCH_LIMIT = 50

type ProcessedTradeRow = Database['public']['Functions']['process_due_accepted_trades_atomic']['Returns'][number]
type OutboxRow = Database['public']['Functions']['claim_notification_outbox_atomic']['Returns'][number]

serveInternal('process-trades', async () => {
  const result = await processAcceptedTrades()
  return Response.json({ ok: true, ...result })
})

async function processAcceptedTrades(): Promise<{
  processed: number
  deferred: number
  failed: number
  failures: string[]
  notificationsDelivered: number
  notificationsDeferred: number
  notificationsDiscarded: number
  notificationsDeadLettered: number
}> {
  await expirePendingTrades()

  const { data, error } = await supabase.rpc('process_due_accepted_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error

  const results: ProcessedTradeRow[] = data ?? []
  const partitioned = partitionTradeResults(results)
  const deliveryResult = await drainNotificationOutbox()

  if (partitioned.retryableFailures.length > 0) {
    throw new Error(`Retryable trade processing failures: ${partitioned.retryableFailures.map(tradeFailureMessage).join('; ')}`)
  }

  return {
    processed: partitioned.completed.length,
    deferred: partitioned.deferred.length,
    failed: partitioned.terminalFailures.length,
    failures: partitioned.terminalFailures.map(tradeFailureMessage),
    notificationsDelivered: deliveryResult.delivered,
    notificationsDeferred: deliveryResult.failed,
    notificationsDiscarded: deliveryResult.discarded,
    notificationsDeadLettered: deliveryResult.deadLettered,
  }
}

async function drainNotificationOutbox(): Promise<{ delivered: number; failed: number; discarded: number; deadLettered: number }> {
  return drainTradeNotificationOutbox(claimNotificationOutbox, deliverNotificationOutbox)
}

async function claimNotificationOutbox(): Promise<OutboxRow[]> {
  const { data, error } = await supabase.rpc('claim_notification_outbox_atomic', {
    p_limit: OUTBOX_CLAIM_LIMIT,
    p_lease_seconds: OUTBOX_LEASE_SECONDS,
  })
  if (error) throw error
  return data ?? []
}

function deliverNotificationOutbox(rows: OutboxRow[]) {
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
    async (row, deliveryError) => {
      const { data: deadLettered, error: deadLetterError } = await supabase.rpc('dead_letter_notification_outbox_atomic', {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: deliveryError,
      })
      if (deadLetterError) throw deadLetterError
      if (!deadLettered) throw new Error(`Notification outbox lease ${row.id} was lost before dead-lettering`)
    },
  )
}

async function expirePendingTrades(): Promise<void> {
  const { data, error } = await supabase.rpc('expire_pending_trades_atomic', {
    p_limit: PROCESS_BATCH_LIMIT,
  })
  if (error) throw error
  void data
}
