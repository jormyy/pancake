import type { NotificationMessage, NotifyMembers } from '../_shared/notifications.ts'

export type CompletedTradeNotificationRow = {
  trade_id: string
  participant_member_ids: string[]
}

async function notifyTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMembers,
  title: string,
  body: string,
): Promise<void> {
  const messages: NotificationMessage[] = rows.flatMap((row) => row.participant_member_ids.map((memberId) => ({
      memberId,
      title,
      body,
      data: { tradeId: row.trade_id },
      category: 'trade',
    })))
  await notify(messages)
}

export function notifyCompletedTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMembers,
): Promise<void> {
  return notifyTrades(rows, notify, 'Trade Completed', 'Assets have moved. Check your roster.')
}

export function notifyExpiredTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMembers,
): Promise<void> {
  return notifyTrades(rows, notify, 'Trade Expired', 'One of your pending trade offers expired.')
}
