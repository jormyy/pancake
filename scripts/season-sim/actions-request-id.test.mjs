import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'replay-request-id-'))
process.env.SEASON_SIM_ROOT = root
await mkdir(path.join(root, 'evidence'))
after(() => rm(root, { recursive: true, force: true }))
const { actionClient, officialLeagueSettings } = await import('./actions.mjs')
const { originUrl } = await import('./common.mjs')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test('replay RPC mutations send a request ID and preserve supplied IDs', async t => {
  const ids = []
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const headers = new Headers(init.headers)
    const id = headers.get('x-request-id')
    assert.match(id ?? '', uuid)
    ids.push(id)
    return new Response('{}')
  })
  const c = actionClient({ API_URL: originUrl('api'), ANON_KEY: 'synthetic' })
  const user = { token: 'synthetic' }
  await c.rpc(user, 'create_league', { p_name: 'Fixture' })
  await c.rpc(user, 'create_league', { p_name: 'Fixture' })
  const explicit = '5dff7cb2-bcdc-4d72-ac91-507c9b54815b'
  await c.rpc(user, 'guarded', { p_request_id: explicit })
  assert.notEqual(ids[0], ids[1])
  assert.equal(ids[2], explicit)
})

test('replay API mutations share one ID between the body and header', async t => {
  const ids = []
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const body = JSON.parse(init.body)
    const id = new Headers(init.headers).get('x-request-id')
    assert.match(id ?? '', uuid)
    assert.equal(body.requestId, id)
    ids.push(id)
    return new Response('{}')
  })
  const c = actionClient({ API_URL: originUrl('api'), ANON_KEY: 'synthetic' })
  const user = { token: 'synthetic' }
  await c.api(user, '/draft/fixture/nominate', { playerId: 'fixture' })
  const explicit = '5dff7cb2-bcdc-4d72-ac91-507c9b54815b'
  await c.api(user, '/trades/propose', { requestId: explicit })
  assert.equal(ids[1], explicit)
})

test('late replay skips only completed regular weeks and retains playoff periods', () => {
  const settings = { skipped_weeks: [1], playoff_start_week: 18 }
  const result = officialLeagueSettings(settings, [20, 18, 17, 2, 1, 19, 2])
  assert.deepEqual(result.skipped_weeks, [1, 2, 17])
  assert.equal(result.playoff_start_week, 18)
  assert.deepEqual(settings.skipped_weeks, [1])
  assert.equal(officialLeagueSettings(settings, null), settings)
})
