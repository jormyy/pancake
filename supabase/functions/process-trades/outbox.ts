import type { Json } from '../_shared/database.ts'
import type { NotificationMessage, NotifyMembers } from '../_shared/notifications.ts'
import { runBounded, type AsyncJob } from '../_shared/runBounded.ts'

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

async function mutateRows(rows: TradeNotificationOutboxRow[], mutation: (row: TradeNotificationOutboxRow) => Promise<void>) {
  const jobs: AsyncJob[] = rows.map((row) => () => mutation(row))
  await runBounded(jobs, OUTBOX_MUTATION_CONCURRENCY)
}

export async function deliverTradeNotificationOutbox(
  rows: TradeNotificationOutboxRow[],
  notify: NotifyMembers,
  complete: Complete,
  fail: Fail,
): Promise<{ delivered: number; failed: number }> {
  if (rows.length === 0) return { delivered: 0, failed: 0 }

  try {
    await notify(rows.map(messageFor))
  } catch (error) {
    const message = errorMessage(error)
    await mutateRows(rows, (row) => fail(row, message))
    return { delivered: 0, failed: rows.length }
  }

  await mutateRows(rows, complete)
  return { delivered: rows.length, failed: 0 }
}
