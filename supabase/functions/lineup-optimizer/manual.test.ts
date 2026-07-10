import {
  MANUAL_DATABASE_REQUEST_BUDGET,
  MANUAL_DATE_CONCURRENCY,
  MANUAL_DATE_LIMIT,
  MANUAL_INTERNAL_REQUEST_BUDGET,
  processManualDates,
} from './manual.ts'

const contexts = Array.from({ length: 8 }, (_, index) => ({
  date: `2027-01-${String(index + 1).padStart(2, '0')}`,
  seasonYear: index === 7 ? 2028 : 2027,
}))

Deno.test('manual season optimization contains date failures and reports a retryable result', async () => {
  const attempts = new Map<string, number>()
  let active = 0
  let maxActive = 0
  const optimize = async (context: (typeof contexts)[number]) => {
    attempts.set(context.date, (attempts.get(context.date) ?? 0) + 1)
    active++
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active--
    if (context.date === contexts[3].date && attempts.get(context.date) === 1) {
      throw new Error('injected date-N failure')
    }
  }

  const first = await processManualDates(contexts, 2027, optimize)
  if (first.optimized !== 6 || first.failed !== 1 || first.skipped !== 1 ||
      first.results[3].status !== 'failed' || first.results[7].status !== 'skipped') {
    throw new Error(`unexpected partial result: ${JSON.stringify(first)}`)
  }

  const retry = await processManualDates(contexts, 2027, optimize)
  if (retry.optimized !== 7 || retry.failed !== 0 || retry.skipped !== 1) {
    throw new Error(`unexpected retry result: ${JSON.stringify(retry)}`)
  }
  if ([...attempts.values()].some((count) => count !== 2)) {
    throw new Error(`full retry did not replay each eligible date: ${JSON.stringify([...attempts])}`)
  }
  if (maxActive > MANUAL_DATE_CONCURRENCY) {
    throw new Error(`manual optimization exceeded concurrency ${MANUAL_DATE_CONCURRENCY}`)
  }
})

Deno.test('manual season optimization has hard request and date budgets', () => {
  if (MANUAL_DATE_LIMIT !== 180 || MANUAL_DATE_CONCURRENCY !== 4 ||
      MANUAL_INTERNAL_REQUEST_BUDGET !== 1 || MANUAL_DATABASE_REQUEST_BUDGET !== 550) {
    throw new Error('manual optimizer budgets changed without updating the contract')
  }
})
