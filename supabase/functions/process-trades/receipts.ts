import { runBounded } from '../_shared/runBounded.ts'

const RECEIPT_MUTATION_CONCURRENCY = 10

export type TradeNotificationReceiptRow = {
  id: string
  claim_token: string
  member_id: string
  expo_ticket_id: string
  push_token: string
}

export type ExpoPushReceipt = {
  status?: unknown
  message?: unknown
  details?: unknown
}

type ReceiptActions = {
  complete: (row: TradeNotificationReceiptRow) => Promise<void>
  invalidate: (row: TradeNotificationReceiptRow) => Promise<void>
  retry: (row: TradeNotificationReceiptRow, error: string) => Promise<void>
  defer: (row: TradeNotificationReceiptRow, error: string) => Promise<void>
  deadLetter: (row: TradeNotificationReceiptRow, error: string) => Promise<void>
}

export async function deferTradeNotificationReceipts(
  rows: TradeNotificationReceiptRow[],
  defer: (row: TradeNotificationReceiptRow) => Promise<void>,
): Promise<void> {
  await runBounded(rows.map((row) => () => defer(row)), RECEIPT_MUTATION_CONCURRENCY)
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const receiptError = (receipt: ExpoPushReceipt): { code: string | null; message: string } => {
  const details = record(receipt.details)
  const code = typeof details?.error === 'string' ? details.error : null
  const message = typeof receipt.message === 'string'
    ? receipt.message
    : code ? `Expo receipt failed with ${code}` : 'Expo receipt returned an invalid status'
  return { code, message }
}

export async function settleTradeNotificationReceipts(
  rows: TradeNotificationReceiptRow[],
  receipts: Record<string, ExpoPushReceipt>,
  actions: ReceiptActions,
): Promise<{ delivered: number; retried: number; deferred: number; discarded: number; deadLettered: number }> {
  let delivered = 0
  let retried = 0
  let deferred = 0
  let discarded = 0
  let deadLettered = 0

  await runBounded(rows.map((row) => async () => {
    const receipt = receipts[row.expo_ticket_id]
    if (!receipt) {
      await actions.defer(row, 'Expo receipt is not available yet')
      deferred += 1
      return
    }
    if (receipt.status === 'ok') {
      await actions.complete(row)
      delivered += 1
      return
    }

    const failure = receiptError(receipt)
    if (receipt.status !== 'error' || !failure.code) {
      await actions.defer(row, failure.message)
      deferred += 1
      return
    }
    if (failure.code === 'DeviceNotRegistered') {
      try {
        await actions.invalidate(row)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await actions.defer(row, `Invalid token cleanup failed: ${message}`)
        deferred += 1
        return
      }
      await actions.complete(row)
      discarded += 1
      return
    }
    if (failure.code === 'MessageTooBig' || failure.code === 'MismatchSenderId') {
      await actions.deadLetter(row, failure.message)
      deadLettered += 1
      return
    }

    await actions.retry(row, failure.message)
    retried += 1
  }), RECEIPT_MUTATION_CONCURRENCY)

  return { delivered, retried, deferred, discarded, deadLettered }
}
