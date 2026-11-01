import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { readWireResponse } from './wire.mjs'

test('phone accounting measures compressed bytes before decoding JSON', async () => {
  const body = JSON.stringify({ value: 'repeated'.repeat(1000) })
  const encoded = gzipSync(body)
  const server = createServer((req, res) => {
    assert.equal(req.headers['accept-encoding'], 'gzip')
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': encoded.length })
    res.end(encoded)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await readWireResponse(`http://127.0.0.1:${server.address().port}`)
    assert.equal(result.wireBytes, encoded.length)
    assert.equal(result.bytes, Buffer.byteLength(body))
    assert.equal(result.body, body)
    assert.equal(result.encoding, 'gzip')
  } finally { await new Promise(resolve => server.close(resolve)) }
})
