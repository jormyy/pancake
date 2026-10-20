import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, test, vi } from 'vitest'
import { localStackEnvironment, runLocalSetup } from './layout-stability-local.mjs'
import { prepareSweepFixtures, requireSweepLocal } from './layout-stability-fixtures.mjs'
import { DEFAULT_SWEEP_PORTS, isSweepEndpoint, requireSweepStack, resolveSweepPorts, stackEnvironment, sweepFetchGuardScript } from './layout-stability-ports.mjs'

const child = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn(() => ({ status: 0 })) }))
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), ...child }))

const ports = { api: '56621', db: '56622', frontend: '56690' }
const flags = { 'api-port': ports.api, 'db-port': ports.db, 'frontend-port': ports.frontend }
const values = { API_URL: 'http://127.0.0.1:56621', DB_URL: 'postgresql://postgres:synthetic@localhost:56622/postgres', PUBLISHABLE_KEY: 'synthetic-public-key', SECRET_KEY: 'synthetic-secret-key' }
const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
  vi.clearAllMocks()
})

const browser = (configured: typeof ports, controlled: boolean) => {
  const original = vi.fn(async (request: Request) => ({ url: request.url }))
  const delay = vi.fn(async () => {})
  const window = { fetch: original, __layoutApiDelay: delay }
  runInNewContext(sweepFetchGuardScript(configured), { window, navigator: { serviceWorker: { controller: controlled ? {} : null } }, Request, Headers, URL })
  return { window, original, delay }
}

test('566xx flags reach seed invocation, saved configuration, fixture guards, and injected fetch', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'layout-stability-ports-'))
  folders.push(output)
  child.execFileSync.mockReturnValue(Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n'))
  await runLocalSetup({ ...flags, 'output-dir': output, seed: 'true' })
  assert.equal(child.spawnSync.mock.calls.length, 1)
  const invocation = child.spawnSync.mock.calls[0] as unknown as [string, string[], { cwd: string; env: Record<string, string> }]
  assert.match(invocation[1][0], /seed-league\.mjs$/)
  assert.equal(invocation[2].cwd, output)
  assert.equal(invocation[2].env.E2E_SUPABASE_URL, values.API_URL)
  assert.equal(invocation[2].env.SUPABASE_DB_URL, values.DB_URL)
  assert.equal(invocation[2].env.E2E_FRONTEND_URL, 'http://127.0.0.1:56690')
  const env = await stackEnvironment(path.join(output, 'local-stack.env'))
  const restored = resolveSweepPorts({}, env)
  assert.deepEqual(restored, ports)
  requireSweepStack(env, restored)
  await assert.rejects(prepareSweepFixtures({ env, ports: restored, statePath: path.join(output, 'missing-state.json'), resourceOwner: undefined }), { code: 'ENOENT' })
  for (const controlled of [false, true]) {
    const client = browser(restored, controlled)
    const request = new Request(`${env.E2E_SUPABASE_URL}/rest/v1/players`, { method: 'POST' })
    await client.window.fetch(request)
    assert.equal(client.original.mock.calls.length, 1)
    assert.equal(client.original.mock.calls[0][0].url, request.url)
    assert.equal(client.delay.mock.calls.length, controlled ? 1 : 0)
    assert.equal(client.original.mock.calls[0][0].headers.get('x-client-info')?.includes('layout-stability-delayed') ?? false, controlled)
  }
})

test('defaults, legacy environment URLs, and explicit overrides select exact ports', () => {
  assert.deepEqual(resolveSweepPorts(), DEFAULT_SWEEP_PORTS)
  assert.deepEqual(resolveSweepPorts({}, { E2E_SUPABASE_URL: values.API_URL, SUPABASE_DB_URL: values.DB_URL, E2E_FRONTEND_URL: 'http://localhost:56690' }), ports)
  assert.deepEqual(resolveSweepPorts(flags, { LAYOUT_STABILITY_API_PORT: '56521', LAYOUT_STABILITY_DB_PORT: '56522', LAYOUT_STABILITY_FRONTEND_PORT: '56590' }), ports)
  assert.equal(resolveSweepPorts({ 'frontend-url': 'http://localhost:56690' }).frontend, '56690')
  for (const value of ['', 'any', '0', '65536', '56621.5', true]) assert.throws(() => resolveSweepPorts({ 'api-port': value }), /Invalid --api-port/)
  requireSweepLocal('http://localhost:56690', ports.frontend)
  assert.equal(isSweepEndpoint('http://localhost:56590', ports.frontend), false)
  assert.throws(() => requireSweepStack(localStackEnvironment(values, ports), { ...ports, api: '56521' }), /Refusing/)
})

test.each([
  'http://127.0.0.1:56521',
  'http://127.0.0.1:56690',
  'http://example.invalid:56621',
  'https://127.0.0.1:56621',
  'http://127.0.0.1:56621/ceeytbfmwsnzalxlkalc',
])('setup, fixture, and both injected fetch paths refuse %s', async (endpoint) => {
  assert.throws(() => localStackEnvironment({ ...values, API_URL: endpoint }, ports), /Refusing/)
  const env = { ...localStackEnvironment(values, ports), E2E_SUPABASE_URL: endpoint }
  await assert.rejects(prepareSweepFixtures({ env, ports, statePath: 'never-read.json', resourceOwner: undefined }), /Refusing/)
  for (const controlled of [false, true]) {
    const client = browser(ports, controlled)
    await assert.rejects(client.window.fetch(new Request(`${endpoint}/rest/v1/players`, { method: 'POST' })), /Layout sweep refuses/)
    assert.equal(client.original.mock.calls.length, 0)
    assert.equal(client.delay.mock.calls.length, 0)
  }
})

test('database and frontend guards reject mismatched ports, hosts, protocols, and production references', () => {
  for (const DB_URL of ['postgresql://localhost:56522/postgres', 'postgresql://example.invalid:56622/postgres', 'http://localhost:56622/postgres', 'postgresql://localhost:56622/ceeytbfmwsnzalxlkalc']) {
    assert.throws(() => localStackEnvironment({ ...values, DB_URL }, ports), /Refusing/)
  }
  const env = localStackEnvironment(values, ports)
  for (const E2E_FRONTEND_URL of ['http://localhost:56590', 'http://example.invalid:56690', 'https://localhost:56690', 'http://localhost:56690/ceeytbfmwsnzalxlkalc']) {
    assert.throws(() => requireSweepStack({ ...env, E2E_FRONTEND_URL }, ports), /Refusing/)
  }
})

test('a mismatched stack stops before writing environment files or invoking the seed', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'layout-stability-ports-'))
  folders.push(output)
  child.execFileSync.mockReturnValue('API_URL="http://127.0.0.1:56521"\nDB_URL="postgresql://localhost:56622/postgres"')
  await assert.rejects(runLocalSetup({ ...flags, 'output-dir': output, seed: 'true' }), /Refusing/)
  assert.equal(child.spawnSync.mock.calls.length, 0)
  await assert.rejects(readFile(path.join(output, 'local-stack.env')), { code: 'ENOENT' })
})
