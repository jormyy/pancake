import { startLeaseHeartbeat } from './leaseHeartbeat.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test('renews on the interval while the lease is held and stops cleanly', async () => {
  let renewals = 0
  const beat = startLeaseHeartbeat(async () => { renewals += 1; return true }, 5)
  await sleep(40)
  beat.stop()
  const seen = renewals
  await sleep(20)
  assert(seen >= 3, `expected several renewals, saw ${seen}`)
  assert(renewals === seen, 'renewals continued after stop')
  assert(beat.lost === false, 'a held lease must not read as lost')
})

Deno.test('flags a lost lease once and stops renewing', async () => {
  let calls = 0
  let lostCount = 0
  const beat = startLeaseHeartbeat(async () => { calls += 1; return calls < 2 }, 5, () => { lostCount += 1 })
  await sleep(50)
  assert(beat.lost === true, 'lease loss was not flagged')
  assert(lostCount === 1, `onLost fired ${lostCount} times`)
  assert(calls === 2, `renewal kept running after loss (${calls} calls)`)
  beat.stop()
})

Deno.test('a renewal error counts as a lost lease', async () => {
  let reason: unknown = null
  const beat = startLeaseHeartbeat(async () => { throw new Error('db down') }, 5, (error) => { reason = error })
  await sleep(30)
  assert(beat.lost === true, 'error did not flag loss')
  assert((reason as Error)?.message === 'db down', 'onLost did not receive the error')
  beat.stop()
})
