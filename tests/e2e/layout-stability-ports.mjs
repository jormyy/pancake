import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

export const DEFAULT_SWEEP_PORTS = Object.freeze({ api: '56121', db: '56122', frontend: '56190' })

export function isSweepEndpoint(value, port, protocols = ['http:']) {
  try {
    const url = new URL(value)
    return !decodeURIComponent(url.href).toLowerCase().includes('ceeytbfmwsnzalxlkalc') &&
      ['127.0.0.1', 'localhost'].includes(url.hostname) && protocols.includes(url.protocol) &&
      (url.port || (url.protocol === 'http:' ? '80' : '')) === String(port)
  } catch { return false }
}

/** @param {string} [port] */
export function requireSweepLocal(value, port = DEFAULT_SWEEP_PORTS.api, protocols = ['http:']) {
  assert.ok(isSweepEndpoint(value, port, protocols), `Refusing non-lane endpoint; expected ${protocols.join('/')} loopback:${port}`)
  return new URL(value)
}

export function resolveSweepPorts(args = {}, env = {}) {
  const urls = { api: env.E2E_SUPABASE_URL, db: env.SUPABASE_DB_URL, frontend: args['frontend-url'] ?? env.E2E_FRONTEND_URL }
  return Object.fromEntries(Object.entries(DEFAULT_SWEEP_PORTS).map(([kind, fallback]) => {
    const value = args[`${kind}-port`] ?? env[`LAYOUT_STABILITY_${kind.toUpperCase()}_PORT`] ??
      (urls[kind] ? new URL(urls[kind]).port || (new URL(urls[kind]).protocol === 'http:' ? '80' : '') : fallback)
    assert.ok(/^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535, `Invalid --${kind}-port`)
    return [kind, String(Number(value))]
  }))
}

export function requireSweepStack(env, ports = resolveSweepPorts({}, env)) {
  requireSweepLocal(env.E2E_SUPABASE_URL, ports.api)
  requireSweepLocal(env.E2E_API_BASE_URL ?? `${env.E2E_SUPABASE_URL}/functions/v1/api`, ports.api)
  for (const key of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_API_URL']) if (env[key]) requireSweepLocal(env[key], ports.api)
  if (env.SUPABASE_DB_URL) requireSweepLocal(env.SUPABASE_DB_URL, ports.db, ['postgres:', 'postgresql:'])
  if (env.E2E_FRONTEND_URL) requireSweepLocal(env.E2E_FRONTEND_URL, ports.frontend)
}

export async function stackEnvironment(file) {
  const env = { ...process.env }
  if (file) for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return env
}

function installSweepFetchGuard(ports, allowed) {
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (/\/(rest|auth|functions|storage)\/v1\//.test(url.pathname)) {
      if (!allowed(url.href, ports.api)) throw new Error('Layout sweep refuses a non-lane API request')
      if (navigator.serviceWorker?.controller) {
        await /** @type {typeof window & { __layoutApiDelay: (request: { url: string, method: string }) => Promise<void> }} */ (window).__layoutApiDelay({ url: url.href, method: request.method })
        const headers = new Headers(request.headers)
        headers.set('x-client-info', `${headers.get('x-client-info') ?? 'layout-sweep'} layout-stability-delayed`)
        return original(new Request(request, { headers }))
      }
    }
    return original(request)
  }
}

export const sweepFetchGuardScript = (ports) => `(${installSweepFetchGuard.toString()})(${JSON.stringify(ports)}, ${isSweepEndpoint.toString()});`
