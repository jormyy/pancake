import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { appendFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { scoreMessage } from './quality-grade.mjs'

const config = JSON.parse(Deno.env.get('GAME_NIGHT_CONFIG'))
const ports = [config.api, config.db, config.edge, config.feed, config.public].filter(Boolean).map(String)
const nativeFetch = globalThis.fetch
const transfers = []
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ports.includes(url.port), `Blocked outbound host: ${url.hostname}:${url.port}`)
  const at=Date.now()
  const response=await nativeFetch(input, { ...init, redirect: 'error' })
  if(url.port===String(config.api)) {
    const body=await response.clone().arrayBuffer()
    transfers.push({at,path:url.pathname,requestBytes:typeof init?.body==='string' ? Buffer.byteLength(init.body) : 0,responseBytes:body.byteLength})
  }
  return response
}
const nativeServe = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')
const handlers = new Map()
let loading
Object.defineProperty(Deno, 'serve', { value: handler => { handlers.set(loading, handler) }, configurable: true })
try {
  for (const entry of readdirSync(config.functions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || !existsSync(path.join(config.functions, entry.name, 'index.ts'))) continue
    loading = entry.name
    await import(pathToFileURL(path.join(config.functions, entry.name, 'index.ts')).href)
    assert.ok(handlers.has(loading), `Handler missing: ${loading}`)
  }
} finally { Object.defineProperty(Deno, 'serve', descriptor) }
let active = 0
let realtimeMessages = 0
let realtimeScoreMessages = 0
const { createClient } = await import('npm:@supabase/supabase-js@2.98.0')
const realtimeClient = createClient(Deno.env.get('SUPABASE_URL'), config.realtimeToken ? Deno.env.get('SUPABASE_ANON_KEY') : Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY'), { auth: { autoRefreshToken: false, persistSession: false } })
if (config.realtimeToken) await realtimeClient.realtime.setAuth(config.realtimeToken)
const realtimeChannel = realtimeClient.channel('l1:league:ab000000-0000-4000-8000-000000000001', { config: { private: true } }).on('broadcast', { event: 'change' }, message => { realtimeMessages++; if (scoreMessage(message) && !config.fault?.split(',').includes('realtimeScores')) realtimeScoreMessages++ })
let realtimeStatus = 'starting'
realtimeChannel.subscribe(status => { realtimeStatus = status })
nativeServe({ hostname: '0.0.0.0', port: config.edge }, async request => {
  const url = new URL(request.url)
  if (url.pathname === '/health') return Response.json({ active, functions: [...handlers.keys()], realtimeStatus, realtimeMessages, realtimeScoreMessages, transfers })
  const name = url.pathname.split('/')[3]
  if (name !== 'api' && request.headers.get('x-internal-function-token') !== Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')) return new Response('Forbidden', { status: 403 })
  const handler = handlers.get(name)
  if (!handler) return new Response('Missing worker', { status: 404 })
  if (config.ingestionOff && name === 'live-poll') return Response.json({ ok: true, action: 'lab-ingestion-disabled' })
  active++
  const receipt = { kind: name, start: Date.now(), status: null }
  try {
    const result = await handler(request)
    receipt.status = result.status
    return result
  } finally {
    receipt.end = Date.now()
    appendFileSync(config.receipts, JSON.stringify(receipt) + '\n')
    active--
  }
})
