import { fetchWithRetry } from './retry.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => { globalThis.fetch = original })
}

const noDelay = { retryDelayMs: () => 0 }

Deno.test('a first attempt that hangs past its timeout is retried with a fresh signal', async () => {
  let calls = 0
  const res = await withFetch(async (_url, init) => {
    calls += 1
    const signal = (init as RequestInit | undefined)?.signal as AbortSignal
    if (calls === 1) {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    assert(!signal.aborted, 'retry must not start with an aborted signal')
    return new Response('ok', { status: 200 })
  }, () => fetchWithRetry('https://cdn.test/x', {}, { attemptTimeoutMs: 20, ...noDelay }))

  assert(calls === 2, `expected 2 attempts, saw ${calls}`)
  assert(res.status === 200, 'retry must succeed')
})

Deno.test('a 5xx is retried once and the retry result is returned', async () => {
  let calls = 0
  const res = await withFetch(async () => {
    calls += 1
    return new Response(calls === 1 ? 'boom' : 'ok', { status: calls === 1 ? 503 : 200 })
  }, () => fetchWithRetry('https://cdn.test/x', {}, noDelay))
  assert(calls === 2, `expected 2 attempts, saw ${calls}`)
  assert(res.status === 200, 'second response must be returned')
})

Deno.test('a 4xx is returned as-is without a retry', async () => {
  let calls = 0
  const res = await withFetch(async () => {
    calls += 1
    return new Response('nope', { status: 404 })
  }, () => fetchWithRetry('https://cdn.test/x', {}, noDelay))
  assert(calls === 1, `expected 1 attempt, saw ${calls}`)
  assert(res.status === 404, '404 must pass through')
})

Deno.test('a caller abort cancels the whole call instead of retrying', async () => {
  let calls = 0
  const controller = new AbortController()
  let thrown: unknown = null
  await withFetch(async (_url, init) => {
    calls += 1
    const signal = (init as RequestInit | undefined)?.signal as AbortSignal
    controller.abort(new Error('caller gave up'))
    if (signal.aborted) throw signal.reason
    return new Response('unreachable')
  }, () => fetchWithRetry('https://cdn.test/x', { signal: controller.signal }, noDelay).catch((error) => { thrown = error }))
  assert(calls === 1, `expected 1 attempt, saw ${calls}`)
  assert((thrown as Error)?.message === 'caller gave up', `expected caller abort reason, got ${String(thrown)}`)
})

// Review C1: headers arrive, then the body stalls. The caller's overall
// deadline must still cancel the body read.
Deno.test('a caller deadline aborts a body that stalls after headers', async () => {
  let thrown: unknown = null
  await withFetch(async (_url, init) => {
    const signal = (init as RequestInit | undefined)?.signal as AbortSignal
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      },
    })
    return new Response(body, { status: 200 })
  }, async () => {
    const res = await fetchWithRetry('https://cdn.test/box', { signal: AbortSignal.timeout(30) }, { attemptTimeoutMs: 1000, ...noDelay })
    // Bounded so a helper that leaves the body unlinked fails instead of hanging
    // the runner; the guard timer is cleared so Deno's leak sanitizer stays quiet.
    let guard: number | undefined
    const bounded = new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('body read did not abort')), 500)
    })
    await Promise.race([res.text(), bounded]).catch((error) => { thrown = error }).finally(() => clearTimeout(guard))
  })
  assert(thrown != null, 'expected the stalled body read to be aborted')
  assert((thrown as { name?: string }).name === 'TimeoutError', `expected TimeoutError, got ${String(thrown)}`)
})
