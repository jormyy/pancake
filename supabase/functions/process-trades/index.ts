import type { Database } from '../_shared/database.ts'
import { notifyMembers } from '../_shared/notifications.ts'
import { serveInternal } from '../_shared/serve.ts'
import { supabase } from '../_shared/supabase.ts'
import { partitionTradeResults, tradeFailureMessage } from './results.ts'
import { deliverTradeNotificationOutbox } from './outbox.ts'
import { settleTradeNotificationReceipts, type ExpoPushReceipt, type TradeNotificationReceiptRow } from './receipts.ts'

const PROCESS_BATCH_LIMIT = 50
const OUTBOX_BATCH_LIMIT = 200
const EXPO_RECEIPTS_URL = Deno.env.get('EXPO_RECEIPTS_URL') ?? 'https://exp.host/--/api/v2/push/getReceipts'
const configuredReceiptDelay = Number(Deno.env.get('EXPO_RECEIPT_DELAY_SECONDS') ?? 900)
const RECEIPT_DELAY_SECONDS = Number.isInteger(configuredReceiptDelay) && configuredReceiptDelay >= 0
  ? Math.min(configuredReceiptDelay, 3600)
  : 900

type ProcessedTradeRow = Database['public']['Functions']['process_due_accepted_trades_atomic']['Returns'][number]
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
  notificationsTicketed: number
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
  const receiptResult = await drainNotificationReceipts()

  if (partitioned.retryableFailures.length > 0) {
    throw new Error(`Retryable trade processing failures: ${partitioned.retryableFailures.map(tradeFailureMessage).join('; ')}`)
  }

  return {
    processed: partitioned.completed.length,
    failed: partitioned.terminalFailures.length,
    failures: partitioned.terminalFailures.map(tradeFailureMessage),
    notificationsDelivered: receiptResult.delivered,
    notificationsTicketed: deliveryResult.ticketed,
    notificationsDeferred: deliveryResult.failed + receiptResult.retried + receiptResult.deferred,
    notificationsDiscarded: deliveryResult.discarded + receiptResult.discarded,
    notificationsDeadLettered: deliveryResult.deadLettered + receiptResult.deadLettered,
  }
}

async function drainNotificationOutbox(): Promise<{ ticketed: number; failed: number; discarded: number; deadLettered: number }> {
  const { data, error } = await supabase.rpc('claim_notification_outbox_atomic', {
    p_limit: OUTBOX_BATCH_LIMIT,
    p_lease_seconds: 60,
  })
  if (error) throw error
  const rows: OutboxRow[] = data ?? []

  return deliverTradeNotificationOutbox(
    rows,
    notifyMembers,
    async (row, ticketId, pushToken) => {
      const { data: recorded, error: recordError } = await supabase.rpc('record_notification_outbox_ticket_atomic', {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_expo_ticket_id: ticketId,
        p_push_token: pushToken,
        p_receipt_delay_seconds: RECEIPT_DELAY_SECONDS,
      })
      if (recordError) throw recordError
      if (!recorded) throw new Error(`Notification outbox lease ${row.id} was lost before ticket persistence`)
    },
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

async function drainNotificationReceipts(): Promise<{
  delivered: number
  retried: number
  deferred: number
  discarded: number
  deadLettered: number
}> {
  const { data, error } = await supabase.rpc('claim_notification_receipts_atomic', {
    p_limit: OUTBOX_BATCH_LIMIT,
    p_lease_seconds: 60,
  })
  if (error) throw error
  const rows = (data ?? []) as TradeNotificationReceiptRow[]
  if (rows.length === 0) return { delivered: 0, retried: 0, deferred: 0, discarded: 0, deadLettered: 0 }

  let receipts: Record<string, ExpoPushReceipt>
  try {
    receipts = await fetchExpoReceipts(rows.map((row) => row.expo_ticket_id))
  } catch (receiptError) {
    const message = receiptError instanceof Error ? receiptError.message : String(receiptError)
    await Promise.all(rows.map((row) => deferReceipt(row, message)))
    return { delivered: 0, retried: 0, deferred: rows.length, discarded: 0, deadLettered: 0 }
  }

  const memberIds = [...new Set(rows.map((row) => row.member_id))]
  const { data: members, error: memberError } = await supabase
    .from('league_members')
    .select('id, user_id')
    .in('id', memberIds)
  if (memberError) {
    await Promise.all(rows.map((row) => deferReceipt(row, `Receipt member lookup failed: ${memberError.message}`)))
    return { delivered: 0, retried: 0, deferred: rows.length, discarded: 0, deadLettered: 0 }
  }
  const userByMemberId = new Map((members ?? []).map((member) => [member.id, member.user_id]))

  return settleTradeNotificationReceipts(rows, receipts, {
    complete: completeReceipt,
    invalidate: async (row) => {
      const userId = userByMemberId.get(row.member_id)
      if (!userId) throw new Error(`Notification member ${row.member_id} no longer exists`)
      const { data: cleared, error: clearError } = await supabase.rpc('clear_push_token_for_user_atomic', {
        p_user_id: userId,
        p_token: row.push_token,
      })
      if (clearError) throw clearError
      if (!cleared) console.warn('[process-trades] receipt token was already rotated', { memberId: row.member_id })
    },
    retry: async (row, receiptError) => failReceipt(row, receiptError),
    defer: deferReceipt,
    deadLetter: deadLetterReceipt,
  })
}

async function fetchExpoReceipts(ticketIds: string[]): Promise<Record<string, ExpoPushReceipt>> {
  const response = await fetch(EXPO_RECEIPTS_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ticketIds }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`Expo receipt request returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !('data' in payload) || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('Expo receipt response did not contain a receipt map')
  }
  return payload.data as Record<string, ExpoPushReceipt>
}

async function completeReceipt(row: TradeNotificationReceiptRow): Promise<void> {
  const { data, error } = await supabase.rpc('complete_notification_outbox_atomic', {
    p_id: row.id,
    p_claim_token: row.claim_token,
  })
  if (error) throw error
  if (!data) throw new Error(`Notification receipt lease ${row.id} was lost before acknowledgement`)
}

async function failReceipt(row: TradeNotificationReceiptRow, receiptError: string): Promise<void> {
  const { data, error } = await supabase.rpc('fail_notification_outbox_atomic', {
    p_id: row.id,
    p_claim_token: row.claim_token,
    p_error: receiptError,
  })
  if (error) throw error
  if (!data) throw new Error(`Notification receipt lease ${row.id} was lost before retry scheduling`)
}

async function deferReceipt(row: TradeNotificationReceiptRow, receiptError: string): Promise<void> {
  const { data, error } = await supabase.rpc('defer_notification_receipt_atomic', {
    p_id: row.id,
    p_claim_token: row.claim_token,
    p_error: receiptError,
    p_retry_delay_seconds: 60,
  })
  if (error) throw error
  if (!data) throw new Error(`Notification receipt lease ${row.id} was lost before deferral`)
}

async function deadLetterReceipt(row: TradeNotificationReceiptRow, receiptError: string): Promise<void> {
  const { data, error } = await supabase.rpc('dead_letter_notification_outbox_atomic', {
    p_id: row.id,
    p_claim_token: row.claim_token,
    p_error: receiptError,
  })
  if (error) throw error
  if (!data) throw new Error(`Notification receipt lease ${row.id} was lost before dead-lettering`)
}
