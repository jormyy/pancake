import assert from 'node:assert/strict'
import { isDatabaseContention, retryDatabaseContention } from './databaseRetry.ts'
import { withWorkContext } from './workContext.ts'

const lock = { code: '55P03', message: 'canceling statement due to lock timeout' }

Deno.test('database retries recognize wrapped lock errors and reject mixed permanent failures', () => {
  assert.equal(isDatabaseContention(lock), true)
  assert.equal(isDatabaseContention(new Error('Resolve players: ' + lock.message)), true)
  assert.equal(isDatabaseContention(new AggregateError([lock, { code: '40001' }])), true)
  assert.equal(isDatabaseContention(new AggregateError([lock, { code: '23514' }])), false)
  assert.equal(isDatabaseContention({ code: '23514', message: lock.message }), false)
  assert.equal(isDatabaseContention(new AggregateError([])), false)
})

Deno.test('database retries preserve the result after a returned lock failure', async () => {
  let calls = 0
  let retries = 0
  const result = await retryDatabaseContention(async () => ++calls === 1 ? { failures: [lock], lines: 1 } : { failures: [], lines: 2 }, {
    failures: result => result.failures, onRetry: () => { retries++ },
  })
  assert.deepEqual(result, { failures: [], lines: 2 })
  assert.equal(calls, 2)
  assert.equal(retries, 1)
})

Deno.test('database retries leave permanent partial failures visible', async () => {
  let calls = 0
  const result = await retryDatabaseContention(async () => { calls++; return { failures: [lock, { code: '23514' }] } }, {
    failures: result => result.failures,
  })
  assert.equal(result.failures.length, 2)
  assert.equal(calls, 1)
})

Deno.test('an expired write deadline prevents another database attempt', async () => {
  let calls = 0
  await assert.rejects(() => retryDatabaseContention(async () => { calls++; throw lock }, { deadline: performance.now() }),
    error => error === lock)
  assert.equal(calls, 1)
})

Deno.test('losing the work lease prevents another database attempt', async () => {
  let calls = 0
  await assert.rejects(() => withWorkContext({ signal: new AbortController().signal, renewLease: () => Promise.reject(new Error('Work lease lost')) },
    () => retryDatabaseContention(async () => { calls++; throw lock })), /Work lease lost/)
  assert.equal(calls, 1)
})

Deno.test('an aborted tick prevents another database attempt', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(() => withWorkContext({ signal: controller.signal }, () => retryDatabaseContention(async () => {
    calls++
    controller.abort(new Error('Tick budget expired'))
    throw lock
  })), /Tick budget expired/)
  assert.equal(calls, 1)
})
