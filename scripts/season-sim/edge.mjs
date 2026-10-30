import assert from 'node:assert/strict'
import { providerTransport, gapSource } from './provider-transport.mjs'
import { assertFetchTarget } from './fetch-guard.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { businessTimers } from './business-timers.mjs'
import { readFileSync } from 'node:fs'
import { appendFileSync } from '../perf-lab/bounded-log.mjs'
import path from 'node:path'
import { config, originUrl, assertTarget, laneDirectory, miniRoot, sha256 } from './common.mjs'
import { virtualDate } from './virtual-clock.mjs'
import { virtualTimers } from './timers.mjs'
import { trackWorkerWait, workerHealth } from './worker-waits.mjs'
import { edgeFunctionNames } from './edge-function-inventory.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tradeValueWorkRequest } from './trade-value-catalog.mjs'

const Deno = globalThis['Deno']
assert.equal(Deno.version.deno, '2.7.14', 'Use the task-local Deno runtime')
assertTarget(Deno.env.get('SUPABASE_URL'), 'api')
assertTarget(Deno.env.get('SUPABASE_DB_URL'), 'db')
const directory = await laneDirectory(path.join(miniRoot, 'state'))
const evidence = await laneDirectory(path.join(miniRoot, 'evidence'))
const clockFile = path.join(directory, 'clock.json')
const readClock = () => JSON.parse(readFileSync(clockFile, 'utf8'))
const NativeDate = Date
const nativeFetch = Deno.env.get('SEASON_SIM_TWO_DAY') === '1' && Deno.env.get('PERF_LAB_CAPTURE_PROFILE') !== 'control'
  ? (await import('../perf-lab/replay-capture.mjs')).measuredFetch(fetch, path.join(evidence, 'replay-edge-access.jsonl')) : fetch
const nativeServe = Deno.serve
const nativeSetTimeout = setTimeout
const nativeSetInterval = setInterval
const nativeClearTimeout = clearTimeout
const requestContext = new AsyncLocalStorage()
const nativeWarn = console.warn.bind(console)
console.warn = (...values) => {
  const warning = values.map(value => value instanceof Error ? value.message : String(value)).join(' ')
  const owner = requestContext.getStore()
  if (owner?.invocation && warning.startsWith('[sync-players] career ')) appendFileSync(path.join(directory, 'provider-requests.jsonl'), `${JSON.stringify({ invocation: owner.invocation, function: owner.function, at: new Date().toISOString(), warning })}\n`)
  nativeWarn(...values)
}
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
const sampleLive = (phase,owner=requestContext.getStore()) => trackWorkerWait(owner,'harness-sample','/__sim/live-sample',async()=>{
  const response = await nativeFetch(`${originUrl('replay')}/__sim/live-sample?phase=${phase}`, { headers: { 'x-sim-probe-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN') }, redirect: 'error' })
  assert.ok(response.ok, `Internal live score sample fails: ${await response.text()}`)
})
globalThis.fetch = async (input, init) => {
  const original = String(input instanceof Request ? input.url : input)
  const owner = requestContext.getStore()
  const requestId = crypto.randomUUID()
  let url
  try {
    let mapped = providerTransport(original)
    if (mapped.pathname.startsWith('/career/athletes/')) {
      let fault
      try { fault = JSON.parse(readFileSync(path.join(directory, 'fault.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (fault?.type === 'guarded-provider') mapped = new URL(`https://blocked.invalid${mapped.pathname}${mapped.search}`)
    }
    url = assertFetchTarget(mapped)
  } catch (error) {
    appendFileSync(path.join(directory, 'provider-requests.jsonl'), `${JSON.stringify({ requestId, invocation: owner?.invocation, function: owner?.function, original, at: new Date().toISOString(), error: error.message, boundaryRejected: true })}\n`)
    throw error
  }
  if (url.href !== original) input = input instanceof Request ? new Request(url, input) : url
  if (url.port === String(config.ports.api) && url.pathname.startsWith('/functions/v1/')) {
    url.port = String(config.ports.edge)
    input = input instanceof Request ? new Request(url, input) : url
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (url.pathname === '/rest/v1/rpc/get_live_poll_work' && headers.has('x-pancake-live-holder')) await sampleLive('before-work')
  fetches++
  const provider = url.port === String(config.ports.replay) && (gapSource(url.pathname) || url.pathname === '/espn/injuries' || url.pathname.startsWith('/espn/live/') || url.pathname.startsWith('/nba/') || url.pathname === '/stats/stats/drafthistory')
  const headersForFetch = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  if (provider) headersForFetch.set('x-sim-provider-request', requestId)
  const receipt = { requestId, invocation: owner?.invocation, function: owner?.function, original, transport: url.href, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), at: new Date().toISOString() }
  try {
    const response = await trackWorkerWait(owner,'fetch-headers',url.pathname,()=>nativeFetch(input, { ...init, headers: headersForFetch, redirect: 'error' }))
    if (provider) {
      const bytes = await response.clone().text()
      let body
      try { body = JSON.parse(bytes) } catch {}
      appendFileSync(path.join(directory, 'provider-requests.jsonl'), `${JSON.stringify({ ...receipt, status: response.status, bodySha256: sha256(bytes), unavailable: body?.unavailable ?? null })}\n`)
    }
    return response
  } catch (error) {
    if (provider || owner?.invocation) appendFileSync(path.join(directory, 'provider-requests.jsonl'), `${JSON.stringify({ ...receipt, error: error.message })}\n`)
    throw error
  } finally { fetches-- }
}
for (const [name, suffix] of Object.entries({
  NBA_CDN_BASE_URL: '/static/json', ESPN_SITE_BASE_URL: '/espn', ESPN_LIVE_BASE_URL: '/espn/live', ESPN_CAREER_BASE_URL: '/career', ESPN_SEARCH_BASE_URL: '/career-search',
  HASHTAG_BASE_URL: '', SLEEPER_BASE_URL: '/sleeper', NBA_STATS_BASE_URL: '/stats', NBA_COM_BASE_URL: '/nba',
  EXPO_PUSH_URL: '/push', EXPO_RECEIPTS_URL: '/receipts',
})) Deno.env.set(name, `${originUrl('replay')}${suffix}`)
const handlers = new Map()
let loading
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')
Object.defineProperty(Deno, 'serve', { value: handler => { assert.ok(loading); handlers.set(loading, handler) }, configurable: true })
try {
  const configuredFunctions = Deno.env.get('SEASON_SIM_FUNCTIONS_ROOT')
  const functions = configuredFunctions ? pathToFileURL(`${path.resolve(configuredFunctions)}/`) : new URL('../../supabase/functions/', import.meta.url)
  const names = edgeFunctionNames(fileURLToPath(functions))
  for (const name of names) {
    loading = name
    await import(new URL(`${name}/index.ts`, functions).href)
    assert.ok(handlers.has(name), `No handler registered for ${name}`)
  }
} finally { Object.defineProperty(Deno, 'serve', descriptor) }
let active = 0
let sequence=0
nativeServe({ hostname: '127.0.0.1', port: config.ports.edge }, async request => {
  const url = new URL(request.url)
  if (['host.lima.internal', '192.168.5.2', 'host.docker.internal'].includes(url.hostname)) {
    assert.equal(url.port, String(config.ports.edge))
    assert.equal(request.headers.get('x-internal-function-token'), Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN'))
  } else assertTarget(url.origin, 'edge')
  if (url.pathname === '/health') return Response.json({ active, fetches, sleeping: [...requests].filter(state => state.waiters.size > 0).length, nextAt: discrete ? timers.next() : null, at: new Date().toISOString(), requests:workerHealth(requests,timers,performance.now()),functions: [...handlers.keys()] })
  const name = url.pathname.split('/')[3]
  const handler = handlers.get(name)
  if (!handler) return Response.json({ error: 'Unknown function' }, { status: 404 })
  active++
  const state = { id:++sequence,function:name,invocation:request.headers.get('x-pancake-invocation-id'),started:performance.now(),waiters: new Set(),io:new Map() }
  requests.add(state)
  const started = performance.now()
  let status = 500
  try {
    const response = await requestContext.run(state, () => handler(tradeValueWorkRequest(name, request)))
    status = response.status
    if (name === 'live-poll' && response.ok) await sampleLive('worker-finished',state)
    return response
  } finally {
    active--
    requests.delete(state)
    appendFileSync(path.join(evidence, 'edge-invocations.jsonl'), `${JSON.stringify({ function: name, at: new Date().toISOString(), realAt: new NativeDate().toISOString(), durationMs: performance.now() - started, status })}\n`)
  }
})
