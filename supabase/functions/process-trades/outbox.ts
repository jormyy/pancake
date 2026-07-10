import type { Json } from '../_shared/database.ts'
import type { NotificationMessage, NotifyMembers } from '../_shared/notifications.ts'
import { notificationFailureDisposition } from '../_shared/notificationDelivery.ts'
import { runBounded } from '../_shared/runBounded.ts'

export const OUTBOX_CLAIM_LIMIT = 10
export const OUTBOX_LEASE_SECONDS = 60
const OUTBOX_MUTATION_CONCURRENCY = OUTBOX_CLAIM_LIMIT

export type TradeNotificationOutboxRow = {
  id: string
  claim_token: string
  member_id: string
  title: string
  body: string
  data: Json
  category: string
}

type Complete = (row: TradeNotificationOutboxRow) => Promise<void>
type Fail = (row: TradeNotificationOutboxRow, error: string) => Promise<void>
type DeadLetter = (row: TradeNotificationOutboxRow, error: string) => Promise<void>
type RecordTicket = (row: TradeNotificationOutboxRow, ticketId: string, pushToken: string) => Promise<void>

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function messageFor(row: TradeNotificationOutboxRow): NotificationMessage {
  if (row.category !== 'trade') throw new Error(`Unsupported trade outbox category: ${row.category}`)
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {}
  return {
    memberId: row.member_id,
    title: row.title,
    body: row.body,
    data,
    category: 'trade',
  }
}

export async function deliverTradeNotificationOutbox(
  rows: TradeNotificationOutboxRow[],
  notify: NotifyMembers,
  recordTicket: RecordTicket,
  complete: Complete,
  fail: Fail,
  deadLetter: DeadLetter,
): Promise<{ ticketed: number; failed: number; discarded: number; deadLettered: number }> {
  if (rows.length === 0) return { ticketed: 0, failed: 0, discarded: 0, deadLettered: 0 }

  let ticketed = 0
  let failed = 0
  let discarded = 0
  let deadLettered = 0
  await runBounded(rows.map((row) => async () => {
    try {
      const [result] = await notify([messageFor(row)])
      if (result?.status === 'skipped') {
        await complete(row)
        discarded += 1
        return
      }
      if (result?.status !== 'sent' || !result.ticketId || !result.pushToken) {
        throw new Error('Expo push delivery did not return durable ticket evidence')
      }
      await recordTicket(row, result.ticketId, result.pushToken)
      ticketed += 1
    } catch (error) {
      const disposition = notificationFailureDisposition(error)
      if (disposition === 'discard') {
        await complete(row)
        discarded += 1
      } else if (disposition === 'dead_letter') {
        await deadLetter(row, errorMessage(error))
        deadLettered += 1
      } else {
        await fail(row, errorMessage(error))
        failed += 1
      }
    }
  }), OUTBOX_MUTATION_CONCURRENCY)
  return { ticketed, failed, discarded, deadLettered }
}
