import { drainDueClaims, MAX_BATCHES } from './drain.ts'

function batches(sequence: string[][]) {
  let calls = 0
  return {
    processBatch: async () => sequence[calls++] ?? [],
    calls: () => calls,
  }
}

function assertEquals(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

Deno.test('a batch emptied by a claim settled after its candidate scan does not end the run', async () => {
  // process_next_waiver_claim_atomic returns no row when the claim it picked was
  // cancelled (or finished by a concurrent run) between its candidate scan and
  // its claim lock, so the batch RPC comes back empty with other leagues due.
  const run = batches([[], ['league-b-claim-1', 'league-b-claim-2']])
  const rows = await drainDueClaims(run.processBatch)
  assertEquals(rows, ['league-b-claim-1', 'league-b-claim-2'], 'processed rows')
})

Deno.test('two empty batches in a row end the run', async () => {
  const run = batches([['claim-1'], [], [], ['never-fetched']])
  const rows = await drainDueClaims(run.processBatch)
  assertEquals(rows, ['claim-1'], 'processed rows')
  assertEquals(run.calls(), 3, 'batch calls')
})

Deno.test('draining retains every non-empty batch in order', async () => {
  const run = batches([['claim-1', 'claim-2'], ['claim-3'], [], ['claim-4'], [], []])
  const rows = await drainDueClaims(run.processBatch)
  assertEquals(rows, ['claim-1', 'claim-2', 'claim-3', 'claim-4'], 'processed rows')
})

Deno.test('the batch backstop bounds a run that never comes back empty', async () => {
  let calls = 0
  const rows = await drainDueClaims(async () => [`claim-${++calls}`])
  assertEquals(calls, MAX_BATCHES, 'batch calls')
  assertEquals(rows.length, MAX_BATCHES, 'processed rows')
})

Deno.test('two empty batches retry while a due claim remains', async () => {
  const run = batches([[], [], ['contended-claim'], [], []])
  let waits = 0
  const rows = await drainDueClaims(run.processBatch, async () => run.calls() < 3 ? 1 : 0, {
    sleep: async () => { waits++ }, now: () => waits * 1000,
  })
  assertEquals(rows, ['contended-claim'], 'claim settled after contention')
  assertEquals(waits, 1, 'retry delay')
})

Deno.test('persistent due claims fail the run after the retry deadline', async () => {
  let elapsed = 0
  let failed = false
  try {
    await drainDueClaims(async () => [], async () => 1, {
      sleep: async () => { elapsed += 1000 }, now: () => elapsed,
    })
  } catch (error) {
    failed = error instanceof Error && error.message.includes('due waiver claims')
  }
  assertEquals(failed, true, 'unfinished due claims trigger reconciliation')
  assertEquals(elapsed, 30000, 'retry budget')
})
