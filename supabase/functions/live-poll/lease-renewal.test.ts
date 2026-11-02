import assert from 'node:assert/strict'
import { renewLivePollLease } from './lease.ts'

Deno.test('successful live lease renewal makes one request', async () => {
  let calls = 0
  assert.equal(await renewLivePollLease(async () => { calls++; return true }), true)
  assert.equal(calls, 1)
})

Deno.test('live lease recovers a temporary gateway renewal failure', async () => {
  let calls = 0
  const held = await renewLivePollLease(async () => {
    calls++
    if (calls === 1) throw { message: 'An invalid response was received from the upstream server' }
    return true
  })
  assert.equal(held, true)
  assert.equal(calls, 2)
})

Deno.test('live lease denial stops without another renewal', async () => {
  let calls = 0
  assert.equal(await renewLivePollLease(async () => { calls++; return false }), false)
  assert.equal(calls, 1)
})

Deno.test('a denied retry cannot revive a lost live lease', async () => {
  let calls = 0
  assert.equal(await renewLivePollLease(async () => {
    calls++
    if (calls === 1) throw { status: 502 }
    return false
  }), false)
  assert.equal(calls, 2)
})

Deno.test('persistent gateway failures remain errors after bounded retries', async () => {
  let calls = 0
  await assert.rejects(() => renewLivePollLease(async () => {
    calls++
    throw new Error('An invalid response was received from the upstream server')
  }))
  assert.equal(calls, 3)
})

Deno.test('live lease authorization and database errors do not retry', async () => {
  for (const failure of [new Error('Forbidden'), { code: '42501', message: 'permission denied' }]) {
    let calls = 0
    await assert.rejects(() => renewLivePollLease(async () => { calls++; throw failure }))
    assert.equal(calls, 1)
  }
})

Deno.test('an expired live lease budget makes no renewal request', async () => {
  let calls = 0
  await assert.rejects(() => renewLivePollLease(async () => { calls++; return true }, Date.now() - 1), /deadline/)
  assert.equal(calls, 0)
})

Deno.test('a late live renewal cannot retry beyond the known lease deadline', async () => {
  const originalNow = Date.now
  let clock = 0
  let calls = 0
  Date.now = () => clock
  try {
    await assert.rejects(() => renewLivePollLease(async timeout => {
      calls++
      assert.equal(timeout, 1000)
      clock = 2000
      throw new Error('An invalid response was received from the upstream server')
    }, 1000))
    assert.equal(calls, 1)
  } finally { Date.now = originalNow }
})
