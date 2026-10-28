import { renewCurrentWorkLease } from './workContext.ts'

export function isDatabaseContention(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(isDatabaseContention)
  if (!error || typeof error !== 'object') return false
  const failure = error as { code?: string; message?: string }
  if (failure.code) return ['55P03', '40P01', '40001'].includes(failure.code)
  return typeof failure.message === 'string' && failure.message.includes('canceling statement due to lock timeout')
}

type RetryOptions<T> = {
  failures?: (result: T) => unknown[]
  onRetry?: (error: unknown, attempt: number) => void
  deadline?: number
}

export async function retryDatabaseContention<T>(run: () => PromiseLike<T>, options: RetryOptions<T> = {}): Promise<T> {
  let retries = 0
  const retry = async (error: unknown) => {
    const pause = Math.min(25 * 2 ** retries, (options.deadline ?? Infinity) - performance.now())
    if (retries >= 4 || pause <= 0) return false
    await renewCurrentWorkLease()
    options.onRetry?.(error, ++retries)
    await new Promise(resolve => setTimeout(resolve, pause))
    await renewCurrentWorkLease()
    return performance.now() < (options.deadline ?? Infinity)
  }
  for (;;) {
    try {
      const result = await run()
      const failures = options.failures?.(result) ?? []
      if (failures.length && failures.every(isDatabaseContention) && await retry(failures[0])) continue
      return result
    } catch (error) {
      if (!isDatabaseContention(error) || !await retry(error)) throw error
    }
  }
}
