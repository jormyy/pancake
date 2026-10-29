import { appendFileSync } from './bounded-log.mjs'
import { safeHeaders, publicUrl } from './common.mjs'

export function measuredFetch(fetcher, file, hooks = {}) {
  const pending = new Set(), failures = []
  const measured = async (input, init) => {
    const request = new Request(input, init)
    const context = await hooks.before?.(request.clone())
    const afterRequest = hooks.after ? request.clone() : null
    const copy = request.clone()
    const startedAt = Date.now()
    const started = performance.now()
    const response = await fetcher(request)
    const body = response.clone()
    const write = Promise.all([copy.arrayBuffer(), body.arrayBuffer()]).then(([sent, received]) => {
      appendFileSync(file, `${JSON.stringify({ startedAt, method: request.method, url: publicUrl(request.url), status: response.status,
        bytesIn: sent.byteLength, bytesOut: received.byteLength, durationMs: performance.now() - started,
        requestHeaders: safeHeaders(Object.fromEntries(request.headers)), responseHeaders: safeHeaders(Object.fromEntries(response.headers)) })}\n`, { mode: 0o600 })
    })
    pending.add(write)
    write.catch(error => failures.push(error)).finally(() => pending.delete(write))
    await hooks.after?.(afterRequest, response.clone(), context)
    return response
  }
  measured.flush = async () => {
    await Promise.allSettled([...pending])
    if (failures.length) throw new AggregateError(failures, 'Replay access capture failed')
  }
  return measured
}
