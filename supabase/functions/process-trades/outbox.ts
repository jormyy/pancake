import type { Json } from '../_shared/database.ts'
import type { NotificationMessage, NotifyMembers } from '../_shared/notifications.ts'
import { isPermanentNotificationFailure } from '../_shared/notificationDelivery.ts'
import { runBounded } from '../_shared/runBounded.ts'

const OUTBOX_MUTATION_CONCURRENCY = 10

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
  complete: Complete,
  fail: Fail,
): Promise<{ delivered: number; failed: number; discarded: number }> {
  if (rows.length === 0) return { delivered: 0, failed: 0, discarded: 0 }

  let delivered = 0
  let failed = 0
  let discarded = 0
  await runBounded(rows.map((row) => async () => {
    try {
      await notify([messageFor(row)])
      await complete(row)
      delivered += 1
    } catch (error) {
      if (isPermanentNotificationFailure(error)) {
        await complete(row)
        discarded += 1
      } else {
        await fail(row, errorMessage(error))
        failed += 1
      }
    }
  }), OUTBOX_MUTATION_CONCURRENCY)
  return { delivered, failed, discarded }
}
