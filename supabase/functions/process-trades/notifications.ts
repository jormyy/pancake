import { runBounded } from '../_shared/runBounded.ts'
import type { NotifyMember } from '../_shared/notifications.ts'

export type CompletedTradeNotificationRow = {
  trade_id: string
  participant_member_ids: string[]
}

async function notifyTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMember,
  concurrency: number,
  title: string,
  body: string,
): Promise<void> {
  const jobs = rows.flatMap((row) => row.participant_member_ids.map((participantMemberId) => async () => {
    await notify(
      participantMemberId,
      title,
      body,
      { tradeId: row.trade_id },
      'trade',
    )
  }))

  await runBounded(jobs, concurrency)
}

export function notifyCompletedTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMember,
  concurrency: number,
): Promise<void> {
  return notifyTrades(rows, notify, concurrency, 'Trade Completed', 'Assets have moved. Check your roster.')
}

export function notifyExpiredTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMember,
  concurrency: number,
): Promise<void> {
  return notifyTrades(rows, notify, concurrency, 'Trade Expired', 'One of your pending trade offers expired.')
}
