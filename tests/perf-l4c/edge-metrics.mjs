import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'

const Deno = globalThis['Deno']
const NativeDate = Date
const scope = new AsyncLocalStorage()
const originalServe = Deno.serve
const originalFetch = globalThis.fetch
const windows = JSON.parse(Deno.env.get('L4C_WINDOWS'))
const output = Deno.env.get('L4C_REQUESTS')
const tracked = new Set(['live-poll', 'sync-stats', 'sync-scores', 'sync-players', 'sync-player-injuries', 'sync-sleeper-projections', 'sync-projections'])
const api = new URL(Deno.env.get('SUPABASE_URL'))
if (api.hostname !== '127.0.0.1' || api.port !== '63021') throw new Error('Use the L4c database')
Object.defineProperty(Deno, 'serve', { configurable: true, value: (...args) => {
  const index = typeof args[0] === 'function' ? 0 : 1
  const handler = args[index]
  args[index] = request => {
    const job = new URL(request.url).pathname.split('/')[3]
    const at = Date.now()
    const window = windows.find(row => at >= row.start && at < row.end)
    if (window && tracked.has(job)) appendFileSync(output, `${JSON.stringify({ kind: 'run', window: window.name, job, at })}\n`)
    return scope.run(job, () => handler(request))
  }
  return originalServe(...args)
} })
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const job = scope.getStore()
  if (!job || url.origin !== api.origin || !url.pathname.startsWith('/rest/v1/')) return originalFetch(request)
  request.headers.set('x-l4c-job', job)
  const at = Date.now()
  const window = windows.find(row => at >= row.start && at < row.end)
  const started = NativeDate.now()
  let status = 0
  try {
    const response = await originalFetch(request)
    status = response.status
    return response
  } finally {
    if (window) appendFileSync(output, `${JSON.stringify({ kind: 'request', window: window.name, job, at, started, finished: NativeDate.now(), path: url.pathname, method: request.method, status })}\n`)
  }
}
await import('../../scripts/season-sim/edge.mjs')
