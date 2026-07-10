export type AsyncJob = () => Promise<void>

export async function runBounded(jobs: AsyncJob[], concurrency: number): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer')
  }

  let next = 0
  const failures: unknown[] = []
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      try {
        await job()
      } catch (error) {
        failures.push(error)
      }
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} bounded job${failures.length === 1 ? '' : 's'} failed`)
  }
}
