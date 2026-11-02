import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { createSharedHttpCache } from './http-cache.mjs'
import { createLiveHandler } from '../../../server/live/handler.ts'

const config = JSON.parse(Deno.env.get('GAME_NIGHT_PUBLIC_CONFIG')!)
let disabled = config.legacy === true
let outage = false
const records: { at: number; milliseconds: number; cpuMicroseconds: number; bytes: number; gzipBytes: number }[] = []
const handler = createLiveHandler({ disabled: () => disabled })
const cache = createSharedHttpCache(async (request: Request) => {
  const started = performance.now(), cpu = process.cpuUsage()
  const response = outage ? Response.json({ error: 'Scripted feed outage' }, { status: 503, headers: { 'cache-control': 'no-store' } }) : await handler(request)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const used = process.cpuUsage(cpu)
  records.push({ at: Date.now(), milliseconds: performance.now() - started, cpuMicroseconds: used.user + used.system, bytes: bytes.byteLength,gzipBytes:gzipSync(bytes).byteLength })
  return new Response(bytes, { status: response.status, headers: response.headers })
})
Deno.serve({ hostname: '127.0.0.1', port: config.port }, async request => {
  const url = new URL(request.url)
  if (url.pathname === '/health') return Response.json({ ready: true, counters: cache.counters, records, memory: Deno.memoryUsage() })
  if (url.pathname === '/control' && request.method === 'POST') {
    const body = await request.json()
    if (typeof body.disabled === 'boolean') disabled = body.disabled
    if (typeof body.outage === 'boolean') outage = body.outage
    return Response.json({ disabled, outage })
  }
  if (!/^\/api\/live\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) return new Response('Not found', { status: 404 })
  return cache.fetch(request)
})
