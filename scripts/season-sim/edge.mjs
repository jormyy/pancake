import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { config, originUrl, assertTarget, laneDirectory, miniRoot } from './common.mjs'
import { virtualDate } from './virtual-clock.mjs'
import { virtualTimers } from './timers.mjs'

const Deno = globalThis['Deno']
assert.equal(Deno.version.deno, '2.7.14', 'Use the task-local Deno runtime')
assertTarget(Deno.env.get('SUPABASE_URL'), 'api')
assertTarget(Deno.env.get('SUPABASE_DB_URL'), 'db')
const directory = await laneDirectory(path.join(miniRoot, 'state'))
const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
const clockFile = path.join(directory, 'clock.json')
const readClock = () => JSON.parse(readFileSync(clockFile, 'utf8'))
const NativeDate = Date
const nativeFetch = fetch
const nativeServe = Deno.serve
const nativeSetTimeout = setTimeout
const nativeSetInterval = setInterval
const nativeAbortTimeout = AbortSignal.timeout
const timers = virtualTimers({ timeout: nativeSetTimeout, interval: nativeSetInterval, abortTimeout: ms => nativeAbortTimeout(ms) }, () => readClock().rate)
globalThis.Date = virtualDate(NativeDate, readClock)
Object.defineProperty(globalThis, 'setTimeout', { value: timers.timeout, configurable: true })
Object.defineProperty(globalThis, 'setInterval', { value: timers.interval, configurable: true })
AbortSignal.timeout = timers.abortTimeout
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  const kind = Object.entries(config.ports).find(([, port]) => String(port) === url.port)?.[0]
  assertTarget(url.origin, kind)
  if (url.port === String(config.ports.api) && url.pathname.startsWith('/functions/v1/')) {
    url.port = String(config.ports.edge)
    input = input instanceof Request ? new Request(url, input) : url
  }
  return nativeFetch(input, { ...init, redirect: 'error' })
}
for (const [name, suffix] of Object.entries({
  NBA_CDN_BASE_URL: '/static/json', ESPN_SITE_BASE_URL: '/espn', ESPN_CAREER_BASE_URL: '/career',
  SLEEPER_BASE_URL: '/sleeper', NBA_STATS_BASE_URL: '/stats', NBA_COM_BASE_URL: '/nba',
  EXPO_PUSH_URL: '/push', EXPO_RECEIPTS_URL: '/receipts',
})) Deno.env.set(name, `${originUrl('replay')}${suffix}`)
const handlers = new Map()
let loading
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')
Object.defineProperty(Deno, 'serve', { value: handler => { assert.ok(loading); handlers.set(loading, handler) }, configurable: true })
try {
  for (const name of ['api', 'sync-rankings', 'sync-projections', 'live-poll', 'sync-schedule', 'sync-players', 'sync-stats', 'sync-scores', 'season-boundary', 'process-waivers', 'process-trades', 'lineup-optimizer', 'close-expired-nominations', 'backfill', 'sync-draft-order']) {
    loading = name
    await import(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url).href)
    assert.ok(handlers.has(name), `No handler registered for ${name}`)
  }
} finally { Object.defineProperty(Deno, 'serve', descriptor) }
let active = 0
nativeServe({ hostname: '127.0.0.1', port: config.ports.edge }, async request => {
  const url = new URL(request.url)
  if (['host.lima.internal', '192.168.5.2', 'host.docker.internal'].includes(url.hostname)) {
    assert.equal(url.port, String(config.ports.edge))
    assert.equal(request.headers.get('x-internal-function-token'), Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN'))
  } else assertTarget(url.origin, 'edge')
  if (url.pathname === '/health') return Response.json({ active, at: new Date().toISOString(), functions: [...handlers.keys()] })
  const name = url.pathname.split('/')[3]
  const handler = handlers.get(name)
  if (!handler) return Response.json({ error: 'Unknown function' }, { status: 404 })
  active++
  const started = performance.now()
  let status = 500
  try {
    const response = await handler(request)
    status = response.status
    return response
  } finally {
    active--
    appendFileSync(path.join(evidence, 'edge-invocations.jsonl'), `${JSON.stringify({ function: name, at: new Date().toISOString(), realAt: new NativeDate().toISOString(), durationMs: performance.now() - started, status })}\n`)
  }
})
