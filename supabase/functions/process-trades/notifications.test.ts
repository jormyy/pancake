import { notifyCompletedTrades } from './notifications.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))
const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error(message)
}
const assertCount = (actual: number, expected: number, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, found ${actual}`)
}

Deno.test('completed trade notifications use bounded concurrency and await every recipient', async () => {
  const gates = Array.from({ length: 4 }, deferred)
  const started: string[] = []
  const completed: string[] = []
  let active = 0
  let maxActive = 0
  const pending = notifyCompletedTrades([{
    trade_id: 'trade-a',
    participant_member_ids: ['member-1', 'member-2', 'member-3', 'member-4'],
  }], async (memberId) => {
    const index = Number(memberId.at(-1)) - 1
    started.push(memberId)
    active += 1
    maxActive = Math.max(maxActive, active)
    await gates[index].promise
    active -= 1
    completed.push(memberId)
  }, 2, () => { throw new Error('unexpected notification failure') })

  await waitFor(() => started.length === 2, 'initial notifications did not start')
  assertCount(started.length, 2, 'initial notification concurrency')
  assertCount(maxActive, 2, 'maximum notification concurrency')
  gates[0].resolve()
  await waitFor(() => started.length === 3, 'next notification did not start')
  assertCount(started.length, 3, 'notifications after first capacity opened')
  gates[1].resolve()
  await waitFor(() => started.length === 4, 'final notification did not start')
  assertCount(started.length, 4, 'notifications after final capacity opened')
  gates[2].resolve()
  gates[3].resolve()
  await pending

  assertCount(completed.length, 4, 'completed notifications')
  assertCount(maxActive, 2, 'maximum notification concurrency')
})

Deno.test('completed trade notification failures are observable after remaining jobs run', async () => {
  const attempted: string[] = []
  const observed: unknown[] = []
  await notifyCompletedTrades([{
    trade_id: 'trade-a',
    participant_member_ids: ['member-1', 'member-2', 'member-3'],
  }], async (memberId) => {
    attempted.push(memberId)
    if (memberId === 'member-2') throw new Error('push failed')
  }, 2, (error) => observed.push(error))

  if (attempted.length !== 3) throw new Error('a failed notification prevented later jobs from running')
  if (observed.length !== 1 || !(observed[0] instanceof AggregateError)) {
    throw new Error('notification failure was not surfaced as an aggregate')
  }
})
