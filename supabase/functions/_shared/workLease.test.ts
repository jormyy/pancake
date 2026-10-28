import { strict as assert } from 'node:assert'
import { renewCurrentWorkLease, withWorkContext } from './workContext.ts'

Deno.test('queued workers renew between phases and nested contexts keep the renewal', async () => {
  const phases: string[] = []
  await withWorkContext({ signal: new AbortController().signal, renewLease: async () => { phases.push('renew') } }, async () => {
    await renewCurrentWorkLease(); phases.push('claim')
    await withWorkContext({ signal: new AbortController().signal }, async () => { await renewCurrentWorkLease(); phases.push('publish') })
  })
  assert.deepEqual(phases,['renew','claim','renew','publish'])
  await renewCurrentWorkLease()
  assert.equal(phases.length,4)
})

Deno.test('a failed renewal blocks the next phase and preserves cancellation', async () => {
  const controller = new AbortController()
  let writes = 0
  await assert.rejects(withWorkContext({ signal: controller.signal, renewLease: async () => { throw new Error('Work lease lost') } }, async () => {
    await renewCurrentWorkLease(); writes++
  }), /Work lease lost/)
  controller.abort(new Error('cancelled'))
  await assert.rejects(withWorkContext({ signal: controller.signal, renewLease: async () => { writes++ } }, renewCurrentWorkLease), /cancelled/)
  assert.equal(writes,0)
})
