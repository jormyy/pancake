// One bounded retry with small jitter for flaky upstream (CDN/provider)
// fetches in the sync functions. Retries a single time on network errors,
// 429s, and 5xx responses; anything else is returned as-is.
export async function fetchWithRetry(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init)
    if (res.ok || (res.status < 500 && res.status !== 429)) return res
    await res.body?.cancel()
  } catch {
    // fall through to the single retry
  }

  await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400))
  return fetch(url, init)
}
