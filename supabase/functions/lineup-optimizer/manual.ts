import { runBounded } from '../_shared/runBounded.ts'

export const MANUAL_DATE_LIMIT = 180
export const MANUAL_DATE_CONCURRENCY = 4
export const MANUAL_INTERNAL_REQUEST_BUDGET = 1
const MANUAL_FIXED_DATABASE_REQUESTS = 10
const MANUAL_DATABASE_REQUESTS_PER_DATE = 3
export const MANUAL_DATABASE_REQUEST_BUDGET =
  MANUAL_FIXED_DATABASE_REQUESTS + MANUAL_DATE_LIMIT * MANUAL_DATABASE_REQUESTS_PER_DATE

export type ManualDateContext = {
  date: string
  seasonYear: number
}

type ManualDateResult = {
  date: string
  status: 'optimized' | 'skipped' | 'failed'
  reason?: 'outside_season' | 'optimization_failed'
}

export type ManualOptimizationResult = {
  dates: number
  optimized: number
  skipped: number
  failed: number
  results: ManualDateResult[]
}

export function parseManualDateFilter(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MANUAL_DATE_LIMIT ||
      !value.every((date): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(`${date}T12:00:00Z`)) &&
        new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date)) {
    throw new TypeError(`dates must contain between 1 and ${MANUAL_DATE_LIMIT} valid calendar dates.`)
  }
  return [...new Set(value)].sort()
}

export async function processManualDates<Context extends ManualDateContext>(
  contexts: Context[],
  seasonYear: number,
  optimize: (context: Context) => Promise<void>,
): Promise<ManualOptimizationResult> {
  if (contexts.length > MANUAL_DATE_LIMIT) {
    throw new RangeError(`Remaining season exceeds the ${MANUAL_DATE_LIMIT}-date optimizer limit.`)
  }

  const results: ManualDateResult[] = contexts.map((context) => ({
    date: context.date,
    status: 'skipped',
    reason: 'outside_season',
  }))
  await runBounded(contexts.map((context, index) => async () => {
    if (context.seasonYear !== seasonYear) return
    try {
      await optimize(context)
      results[index] = { date: context.date, status: 'optimized' }
    } catch (error) {
      console.error('[lineup-optimizer] date optimization failed', {
        date: context.date,
        error,
      })
      results[index] = {
        date: context.date,
        status: 'failed',
        reason: 'optimization_failed',
      }
    }
  }), MANUAL_DATE_CONCURRENCY)

  return {
    dates: results.length,
    optimized: results.filter((result) => result.status === 'optimized').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    results,
  }
}
