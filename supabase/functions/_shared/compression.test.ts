import assert from 'node:assert/strict'
import { compressApiResponse } from './compression.ts'

Deno.test('API gzip preserves JSON and reports the encoded wire length', async () => {
  const value = { rows: Array.from({ length: 200 }, (_, id) => ({ id, name: 'Repeated name' })) }
  const response = await compressApiResponse(new Request('http://localhost/api', { headers: { 'accept-encoding': 'br, gzip' } }), Response.json(value))
  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.match(response.headers.get('vary')!, /Accept-Encoding/)
  const bytes = await response.arrayBuffer()
  assert.equal(bytes.byteLength, Number(response.headers.get('content-length')))
  assert.ok(bytes.byteLength < JSON.stringify(value).length / 3)
  const decoded = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
  assert.deepEqual(decoded, value)
})

Deno.test('API compression respects refusal, small errors, and existing encoding', async () => {
  for (const encoding of ['', 'gzip;q=0', 'gzip;q=0.000, br']) {
    const response = await compressApiResponse(new Request('http://localhost/api', { headers: { 'accept-encoding': encoding } }), Response.json({ data: 'a'.repeat(2000) }))
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal((await response.json()).data.length, 2000)
  }
  const small = await compressApiResponse(new Request('http://localhost/api', { headers: { 'accept-encoding': 'gzip' } }), Response.json({ error: 'Denied' }, { status: 403 }))
  assert.equal(small.status, 403)
  assert.deepEqual(await small.json(), { error: 'Denied' })
  assert.equal(small.headers.get('content-encoding'), null)
})
