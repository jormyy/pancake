import { strict as assert } from 'node:assert'
import { vacuumResponses } from './postgres.ts'

Deno.test('maintenance uses one fixed statement outside a transaction', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const handled = (async () => {
    const connection = await listener.accept()
    const read = async (size: number) => {
      const bytes = new Uint8Array(size)
      let offset = 0
      while (offset < size) {
        const length = await connection.read(bytes.subarray(offset))
        assert.ok(length)
        offset += length
      }
      return bytes
    }
    const write = async (type: string, body: Uint8Array) => {
      const bytes = new Uint8Array(body.length + 5)
      bytes[0] = type.charCodeAt(0)
      new DataView(bytes.buffer).setInt32(1, body.length + 4)
      bytes.set(body, 5)
      await connection.write(bytes)
    }
    try {
      assert.equal(new DataView((await read(8)).buffer).getInt32(4), 80877103)
      await connection.write(new Uint8Array([78]))
      const header = await read(4)
      await read(new DataView(header.buffer).getInt32(0) - 4)
      await write('R', new Uint8Array([0, 0, 0, 3]))
      const password = await read(5)
      assert.equal(password[0], 112)
      assert.equal(new TextDecoder().decode(await read(new DataView(password.buffer).getInt32(1) - 4)), 'local-test\0')
      await write('R', new Uint8Array([0, 0, 0, 0]))
      await write('Z', new Uint8Array([73]))
      const query = await read(5)
      assert.equal(query[0], 81)
      assert.equal(new TextDecoder().decode(await read(new DataView(query.buffer).getInt32(1) - 4)), 'VACUUM (ANALYZE, INDEX_CLEANUP ON) net._http_response\0')
      await write('C', new TextEncoder().encode('VACUUM\0'))
      await write('Z', new Uint8Array([73]))
    } finally {
      connection.close()
    }
  })()
  try {
    await vacuumResponses(`postgresql://postgres:local-test@127.0.0.1:${listener.addr.port}/postgres`)
    await handled
  } finally {
    listener.close()
  }
})

const databaseUrl = Deno.env.get('WORK_QUEUE_TEST_DB_URL')
Deno.test({ name: 'maintenance authenticates to the private database and rejects a bad password', ignore: !databaseUrl, fn: async () => {
  const url = new URL(databaseUrl!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname))
  assert.equal(url.port, '59322')
  url.searchParams.set('sslmode', 'disable')
  await vacuumResponses(url.href)
  url.password = 'deliberately-wrong-password'
  await assert.rejects(vacuumResponses(url.href), /authentication failed/)
} })
