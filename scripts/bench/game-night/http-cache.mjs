export function createSharedHttpCache(origin, { now = Date.now, maxBytes = 10000000 } = {}) {
  const entries = new Map(), pending = new Map()
  const counters = { requests: 0, originRequests: 0, hits: 0, stale: 0, bytes: 0 }
  const response = (entry, state, method) => {
    const headers = new Headers(entry.headers)
    headers.set('age', String(Math.max(0, Math.floor((now()-entry.at)/1000))))
    headers.set('x-vercel-cache', state)
    counters.bytes += method === 'HEAD' ? 0 : entry.body.byteLength
    return new Response(method === 'HEAD' ? null : entry.body.slice(), { status: entry.status, headers })
  }
  const load = request => {
    const key = request.url
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      counters.originRequests++
      const result = await origin(new Request(request.url, { method: 'GET', headers: request.headers }))
      const body = new Uint8Array(await result.arrayBuffer())
      const headers = [...result.headers]
      const policy = result.headers.get('cache-control') ?? ''
      const seconds = name => Number(new RegExp(`(?:^|,)\\s*${name}=(\\d+)`).exec(policy)?.[1] ?? 0)*1000
      const entry = { body, headers, status: result.status, at: now(), ttl: seconds('s-maxage'), swr: seconds('stale-while-revalidate') }
      if (result.status === 200 && entry.ttl > 0 && body.byteLength <= maxBytes && !result.headers.has('set-cookie')
        && !/(?:private|no-cache|no-store)/.test(policy) && result.headers.get('vary') !== '*') entries.set(key,entry)
      return entry
    })().finally(() => pending.delete(key))
    pending.set(key,task)
    return task
  }
  return {
    counters,
    async fetch(request) {
      counters.requests++
      if (!['GET','HEAD'].includes(request.method) || request.headers.has('authorization')) return origin(request)
      const previous = entries.get(request.url)
      const age = previous ? now()-previous.at : Infinity
      if (previous && age < previous.ttl) { counters.hits++; return response(previous,'HIT',request.method) }
      if (previous && age < previous.ttl+previous.swr) {
        counters.stale++
        void load(request).catch(() => {})
        return response(previous,'STALE',request.method)
      }
      return response(await load(request),'MISS',request.method)
    },
    settle: () => Promise.allSettled([...pending.values()]),
  }
}
