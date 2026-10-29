import { labTarget } from './target.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { internalEdgeRequest } from './edge-routing.mjs'
import { measuredFetch } from './replay-capture.mjs'

const { ports } = labTarget()
const runtime = globalThis['Deno']
const nativeServe = runtime.serve
const nativeFetch = globalThis.fetch
const directory = runtime.env.get('PERF_LAB_EVIDENCE')
const port = Number(runtime.env.get('PERF_LAB_EDGE_PORT') ?? ports.edge)
const recordedFetch = measuredFetch(request => nativeFetch(request, { redirect: 'error' }), path.join(directory, 'edge-requests.jsonl'))
if (port !== ports.edge) throw new Error('Wrong private Edge port')
const handlers = new Map()
let current, active = 0
Object.defineProperty(runtime, 'serve', { configurable: true, value: handler => { handlers.set(current, handler) } })
Object.defineProperty(globalThis, 'EdgeRuntime', { configurable: true, value: { waitUntil: promise => promise.catch(error => console.error(error.message)) } })
globalThis.fetch = async (input, init) => {
  const request = internalEdgeRequest(new Request(input, init))
  const url = new URL(request.url)
  const headshot = url.origin === 'https://cdn.nba.com' && !url.search && !url.hash && /^\/headshots\/nba\/latest\/260x190\/(\d{3,10})\.png$/.exec(url.pathname)
  if (headshot) {
    const root = runtime.env.get('PERF_LAB_HEADSHOTS')
    const metadata = JSON.parse(readFileSync(path.join(root, `${headshot[1]}.json`), 'utf8'))
    const bytes = readFileSync(path.join(root, `${headshot[1]}.png`))
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('Headshot fixture hash changed')
    return new Response(bytes, { status: metadata.status, headers: { 'content-type': metadata.contentType ?? 'image/png' } })
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || ![ports.api, ports.edge, ports.fixtures].includes(Number(url.port))) throw new Error('Lab blocks an external Edge request')
  return recordedFetch(request)
}
try {
  for (const entry of readdirSync(new URL('../../supabase/functions/', import.meta.url), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    current = entry.name
    await import(new URL(`../../supabase/functions/${entry.name}/index.ts`, import.meta.url).href)
  }
} finally { Object.defineProperty(runtime, 'serve', { configurable: true, value: nativeServe }) }
nativeServe({ hostname: '127.0.0.1', port }, async request => {
  const url = new URL(request.url)
  if (url.pathname === '/health') return Response.json({ active, functions: [...handlers.keys()] })
  const handler = handlers.get(url.pathname.split('/')[3])
  if (!handler) return Response.json({ error: 'Unknown local function' }, { status: 404 })
  active++
  try {
    const response = await handler(request)
    await recordedFetch.flush()
    return response
  }
  catch (error) { console.error(error.message); return Response.json({ error: 'Local Edge execution failed' }, { status: 500 }) }
  finally { active-- }
})
