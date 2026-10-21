import assert from 'node:assert/strict'
import { assertFetchTarget } from './fetch-guard.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { businessTimers } from './business-timers.mjs'
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
const nativeClearTimeout = clearTimeout
const requestContext = new AsyncLocalStorage()
const requests = new Set()
let fetches = 0
const nativeAbortTimeout = AbortSignal.timeout
const legacyTimers = virtualTimers({ timeout: nativeSetTimeout, interval: nativeSetInterval, abortTimeout: ms => nativeAbortTimeout(ms) }, () => readClock().rate)
globalThis.Date = virtualDate(NativeDate, readClock)
const discrete = Deno.env.get('SEASON_SIM_DISCRETE_CLOCK') === '1'
const timers = discrete ? businessTimers({ timeout: nativeSetTimeout, interval: nativeSetInterval, clear: nativeClearTimeout, now: () => Date.now(), context: () => requestContext.getStore() }) : legacyTimers
if (discrete) {
  Object.defineProperty(globalThis, 'clearTimeout', { value: timers.clear, configurable: true })
  Object.defineProperty(globalThis, 'clearInterval', { value: timers.clear, configurable: true })
}
Object.defineProperty(globalThis, 'setTimeout', { value: timers.timeout, configurable: true })
Object.defineProperty(globalThis, 'setInterval', { value: timers.interval, configurable: true })
AbortSignal.timeout = legacyTimers.abortTimeout
const sampleLive = async phase => {
  const response = await nativeFetch(`${originUrl('replay')}/__sim/live-sample?phase=${phase}`, { headers: { 'x-sim-probe-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN') }, redirect: 'error' })
  assert.ok(response.ok, `Internal live score sample fails: ${await response.text()}`)
}
globalThis.fetch = async (input, init) => {
  const url = assertFetchTarget(input instanceof Request ? input.url : input)
  if (url.port === String(config.ports.api) && url.pathname.startsWith('/functions/v1/')) {
    url.port = String(config.ports.edge)
    input = input instanceof Request ? new Request(url, input) : url
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (url.pathname === '/rest/v1/rpc/get_live_poll_work' && headers.has('x-pancake-live-holder')) await sampleLive('before-work')
  fetches++
  try { return await nativeFetch(input, { ...init, redirect: 'error' }) } finally { fetches-- }
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
  if (url.pathname === '/health') return Response.json({ active, fetches, sleeping: [...requests].filter(state => state.waiters.size > 0).length, nextAt: discrete ? timers.next() : null, at: new Date().toISOString(), functions: [...handlers.keys()] })
  const name = url.pathname.split('/')[3]
  const handler = handlers.get(name)
  if (!handler) return Response.json({ error: 'Unknown function' }, { status: 404 })
  active++
  const state = { waiters: new Set() }
  requests.add(state)
  const started = performance.now()
  let status = 500
  try {
    const response = await requestContext.run(state, () => handler(request))
    status = response.status
    if (name === 'live-poll' && response.ok) await sampleLive('worker-finished')
    return response
  } finally {
    active--
    requests.delete(state)
    appendFileSync(path.join(evidence, 'edge-invocations.jsonl'), `${JSON.stringify({ function: name, at: new Date().toISOString(), realAt: new NativeDate().toISOString(), durationMs: performance.now() - started, status })}\n`)
  }
})
