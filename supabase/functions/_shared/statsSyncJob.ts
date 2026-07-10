const STATS_SYNC_BATCH_SIZE = 3

export type StatsSyncJobMetadata = {
  startDate: string
  endDate: string
  nextDate: string
  claimedAt?: string
}

type StatsSyncCheckpoint = {
  completedItems: number
  metadata: StatsSyncJobMetadata
  completed: boolean
}

type StatsSyncJobDependencies = {
  syncDate: (date: string) => Promise<void>
  checkpoint: (checkpoint: StatsSyncCheckpoint) => Promise<void>
  enqueueContinuation: () => Promise<void>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function addStatsSyncDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10)
}

export function statsSyncRange(today: string, days: number): StatsSyncJobMetadata {
  if (!DATE_RE.test(today) || Number.isNaN(Date.parse(`${today}T12:00:00Z`))) {
    throw new RangeError('today must be an ISO date')
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError('days must be an integer between 1 and 365')
  }
  const startDate = addStatsSyncDays(today, 1 - days)
  return { startDate, endDate: today, nextDate: startDate }
}

export function parseStatsSyncJobMetadata(value: unknown): StatsSyncJobMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stats sync job metadata is invalid')
  }
  const metadata = value as Record<string, unknown>
  const startDate = metadata.startDate
  const endDate = metadata.endDate
  const nextDate = metadata.nextDate
  if (typeof startDate !== 'string' || !DATE_RE.test(startDate)) {
    throw new Error('Stats sync job startDate is invalid')
  }
  if (typeof endDate !== 'string' || !DATE_RE.test(endDate)) {
    throw new Error('Stats sync job endDate is invalid')
  }
  if (typeof nextDate !== 'string' || !DATE_RE.test(nextDate)) {
    throw new Error('Stats sync job nextDate is invalid')
  }
  if (startDate > nextDate || nextDate > endDate) {
    throw new Error('Stats sync job cursor is outside its date range')
  }
  return {
    startDate,
    endDate,
    nextDate,
    ...(typeof metadata.claimedAt === 'string' ? { claimedAt: metadata.claimedAt } : {}),
  }
}

export async function runStatsSyncJobBatch(
  metadata: StatsSyncJobMetadata,
  completedItems: number,
  dependencies: StatsSyncJobDependencies,
): Promise<{ completedItems: number; completed: boolean; nextDate: string }> {
  let nextDate = metadata.nextDate
  let completed = completedItems

  for (let processed = 0; processed < STATS_SYNC_BATCH_SIZE && nextDate <= metadata.endDate; processed += 1) {
    await dependencies.syncDate(nextDate)
    completed += 1
    nextDate = addStatsSyncDays(nextDate, 1)
    const jobCompleted = nextDate > metadata.endDate
    await dependencies.checkpoint({
      completedItems: completed,
      metadata: { ...metadata, nextDate, claimedAt: metadata.claimedAt },
      completed: jobCompleted,
    })
    if (jobCompleted) return { completedItems: completed, completed: true, nextDate }
  }

  await dependencies.enqueueContinuation()
  return { completedItems: completed, completed: false, nextDate }
}
