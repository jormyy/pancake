// One bounded retry with small jitter for flaky upstream (CDN/provider)
// fetches in the sync functions. Retries a single time on network errors,
// 429s, and 5xx responses; anything else is returned as-is.
//
// Each attempt gets its own timeout. A caller-supplied signal still cancels the
// whole call, but a per-attempt abort (the classic CDN hang) must not poison the
// retry: re-issuing fetch with an already-aborted signal fails instantly.
export type FetchRetryOptions = {
  attemptTimeoutMs?: number
  retryDelayMs?: () => number
}

function shouldRetry(res: Response): boolean {
  return !res.ok && (res.status >= 500 || res.status === 429)
}

type Attempt = { response: Response; unlink: () => void }

async function attempt(url: string | URL, init: RequestInit | undefined, timeoutMs: number | undefined): Promise<Attempt> {
  const outer = init?.signal ?? null
  if (outer?.aborted) throw outer.reason ?? new DOMException('The operation was aborted.', 'AbortError')

  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(outer?.reason)
  outer?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = timeoutMs == null
    ? null
    : setTimeout(() => controller.abort(new DOMException('Attempt timed out.', 'TimeoutError')), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    // The per-attempt timer only guards the wait for headers. The caller's own
    // signal stays linked so a later abort (an overall deadline) still cancels
    // the body stream the caller is reading; a discarded attempt unlinks it.
    return { response, unlink: () => outer?.removeEventListener('abort', onOuterAbort) }
  } catch (error) {
    outer?.removeEventListener('abort', onOuterAbort)
    throw error
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  // No per-attempt timeout unless the caller asks for one (callers without a
  // budget keep their previous behaviour).
  const timeoutMs = options.attemptTimeoutMs
  const delay = options.retryDelayMs ?? (() => 300 + Math.random() * 400)

  let firstError: unknown = null
  try {
    const first = await attempt(url, init, timeoutMs)
    if (!shouldRetry(first.response)) return first.response
    first.unlink()
    await first.response.body?.cancel()
  } catch (error) {
    firstError = error
  }

  // A caller cancelling the whole call is not a transient upstream failure.
  if (init?.signal?.aborted) throw firstError ?? init.signal.reason

  await new Promise((resolve) => setTimeout(resolve, delay()))
  return (await attempt(url, init, timeoutMs)).response
}
