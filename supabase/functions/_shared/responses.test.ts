import { strict as assert } from 'node:assert'
import { internalServerError } from './responses.ts'

Deno.test('internal errors log message and stack without arbitrary error fields or configured secrets', async () => {
  const original = console.error
  const calls: unknown[][] = []
  const token = 'fixture-internal-secret'
  Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', token)
  console.error = (...values) => { calls.push(values) }
  try {
    const error = Object.assign(new Error(`Worker failed with ${token}`), { authorization: `Bearer ${token}`, payload: { password: 'private-payload' } })
    const response = internalServerError('fixture-worker', error)
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.error, 'Internal server error')
    const output = JSON.stringify(calls)
    assert.ok(output.includes('Worker failed with'))
    assert.ok(output.includes('responses.test.ts'))
    assert.ok(!output.includes(token))
    assert.ok(!output.includes('private-payload'))
    assert.ok(!output.includes('authorization'))
    assert.ok(!JSON.stringify(body).includes('Worker failed'))
  } finally {
    console.error = original
    Deno.env.delete('PANCAKE_EDGE_INTERNAL_TOKEN')
  }
})
