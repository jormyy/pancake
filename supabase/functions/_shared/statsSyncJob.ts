const MAX_EMPTY_DATE_SCANS = 31
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type StatsSyncJobMetadata = {
  startDate: string
  endDate: string
  nextDate: string
  afterGameId?: string
}

type StatsSyncJobDependencies = {
  findNextGame: (date: string, afterGameId?: string) => Promise<string | null>
  syncGame: (gameId: string) => Promise<void>
  checkpoint: (completedItems: number, metadata: StatsSyncJobMetadata) => Promise<void>
  release: (completedItems: number, metadata: StatsSyncJobMetadata) => Promise<void>
  complete: (completedItems: number, metadata: StatsSyncJobMetadata) => Promise<void>
}

export type StatsSyncJobUnitResult = {
  completedItems: number
  completed: boolean
  processedGame: boolean
  metadata: StatsSyncJobMetadata
}

function addStatsSyncDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10)
}

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, 12))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

export function statsSyncRange(today: string, days: number): StatsSyncJobMetadata {
  if (!isIsoDate(today)) throw new RangeError('today must be an ISO date')
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
  const afterGameId = metadata.afterGameId
  if (typeof startDate !== 'string' || !isIsoDate(startDate)) {
    throw new Error('Stats sync job startDate is invalid')
  }
  if (typeof endDate !== 'string' || !isIsoDate(endDate)) {
    throw new Error('Stats sync job endDate is invalid')
  }
  if (typeof nextDate !== 'string' || !isIsoDate(nextDate)) {
    throw new Error('Stats sync job nextDate is invalid')
  }
  if (startDate > endDate || startDate > nextDate || nextDate > addStatsSyncDays(endDate, 1)) {
    throw new Error('Stats sync job cursor is outside its date range')
  }
  if (afterGameId !== undefined && (typeof afterGameId !== 'string' || !UUID_RE.test(afterGameId))) {
    throw new Error('Stats sync job afterGameId is invalid')
  }
  if (nextDate > endDate && afterGameId !== undefined) {
    throw new Error('Completed stats sync cursor cannot retain a game id')
  }
  return {
    startDate,
    endDate,
    nextDate,
    ...(typeof afterGameId === 'string' ? { afterGameId } : {}),
  }
}

export async function runStatsSyncJobUnit(
  initialMetadata: StatsSyncJobMetadata,
  completedItems: number,
  dependencies: StatsSyncJobDependencies,
): Promise<StatsSyncJobUnitResult> {
  let metadata = parseStatsSyncJobMetadata(initialMetadata)

  for (let scanned = 0; scanned < MAX_EMPTY_DATE_SCANS; scanned += 1) {
    if (metadata.nextDate > metadata.endDate) {
      await dependencies.complete(completedItems, metadata)
      return { completedItems, completed: true, processedGame: false, metadata }
    }

    const gameId = await dependencies.findNextGame(metadata.nextDate, metadata.afterGameId)
    if (gameId) {
      await dependencies.syncGame(gameId)
      completedItems += 1
      metadata = { ...metadata, afterGameId: gameId }
      await dependencies.checkpoint(completedItems, metadata)
      await dependencies.release(completedItems, metadata)
      return { completedItems, completed: false, processedGame: true, metadata }
    }

    metadata = {
      startDate: metadata.startDate,
      endDate: metadata.endDate,
      nextDate: addStatsSyncDays(metadata.nextDate, 1),
    }
  }

  if (metadata.nextDate > metadata.endDate) {
    await dependencies.complete(completedItems, metadata)
    return { completedItems, completed: true, processedGame: false, metadata }
  }

  await dependencies.release(completedItems, metadata)
  return { completedItems, completed: false, processedGame: false, metadata }
}
