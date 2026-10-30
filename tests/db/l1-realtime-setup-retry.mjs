import { setTimeout as delay } from 'node:timers/promises'

export async function setupRequest(url, options, { operation, retries, fetcher = fetch, pause = delay, record = async () => {} }) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20000) })
    if (response.status < 500 || response.status >= 600 || attempt === 5) return response
    const retry = { operation, attempt, status: response.status, delayMs: 500 * 2 ** (attempt - 1), at: new Date().toISOString() }
    retries.push(retry)
    await response.body?.cancel()
    await record(retry)
    await pause(retry.delayMs)
  }
  throw new Error('Setup request exhausted its retry bound')
}
