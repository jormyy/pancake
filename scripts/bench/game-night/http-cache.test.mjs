import assert from 'node:assert/strict'
import test from 'node:test'
import { createSharedHttpCache } from './http-cache.mjs'

test('shared cache uses thirty seconds, then revalidates without changing the stored source time', async () => {
  let now = 1000, version = 0
  const cache = createSharedHttpCache(async () => Response.json({ version: version++, capturedAt: now }, { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=15, stale-if-error=90' } }), { now: () => now })
  const request = () => new Request('http://local/api/live/2026-11-01')
  assert.equal((await (await cache.fetch(request())).json()).version,0)
  now += 29999
  assert.equal((await (await cache.fetch(request())).json()).capturedAt,1000)
  assert.equal(cache.counters.originRequests,1)
  now++
  const stale = await cache.fetch(request())
  assert.equal(stale.headers.get('x-vercel-cache'),'STALE')
  assert.equal((await stale.json()).version,0)
  await cache.settle()
  assert.equal((await (await cache.fetch(request())).json()).version,1)
  assert.equal(cache.counters.originRequests,2)
})

test('the Vercel cache ignores stale-if-error after the revalidation window', async () => {
  let now = 0, failed = false
  const cache = createSharedHttpCache(async () => failed ? new Response(null,{status:503})
    : Response.json({ capturedAt: now }, { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=15, stale-if-error=90' } }), { now: () => now })
  const request = () => new Request('http://local/api/live/2026-11-01')
  await cache.fetch(request())
  failed = true
  now = 46000
  assert.equal((await cache.fetch(request())).status,503)
  now = 120001
  assert.equal((await cache.fetch(request())).status,503)
})

test('authorization and non-cacheable responses do not create shared entries', async () => {
  const cache = createSharedHttpCache(async () => Response.json({}, { headers: { 'cache-control': 'no-store' } }))
  for (let n=0;n<2;n++) await cache.fetch(new Request('http://local/api/live/2026-11-01'))
  assert.equal(cache.counters.originRequests,2)
  assert.equal(cache.counters.hits,0)
  await cache.fetch(new Request('http://local/api/live/2026-11-01', { headers: { authorization: 'fixture' } }))
  assert.equal(cache.counters.originRequests,2)
})
