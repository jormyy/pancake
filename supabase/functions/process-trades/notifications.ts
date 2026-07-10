import { runBounded } from '../_shared/runBounded.ts'

export type CompletedTradeNotificationRow = {
  trade_id: string
  participant_member_ids: string[]
}

type NotifyMember = (
  memberId: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
  category: 'trade',
) => Promise<void>

export async function notifyCompletedTrades(
  rows: CompletedTradeNotificationRow[],
  notify: NotifyMember,
  concurrency: number,
  onError: (error: unknown) => void,
): Promise<void> {
  const jobs = rows.flatMap((row) => row.participant_member_ids.map((participantMemberId) => async () => {
    await notify(
      participantMemberId,
      'Trade Completed',
      'Assets have moved. Check your roster.',
      { tradeId: row.trade_id },
      'trade',
    )
  }))

  await runBounded(jobs, concurrency).catch(onError)
}
