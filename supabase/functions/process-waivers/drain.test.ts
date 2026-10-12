import { drainDueClaims, MAX_BATCHES } from './drain.ts'

function batches(sequence: string[][]) {
  let calls = 0
  const notified: string[][] = []
  return {
    processBatch: async () => sequence[calls++] ?? [],
    onBatch: async (rows: string[]) => { notified.push(rows) },
    calls: () => calls,
    notified,
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
  const rows = await drainDueClaims(run.processBatch, run.onBatch)
  assertEquals(rows, ['league-b-claim-1', 'league-b-claim-2'], 'processed rows')
  assertEquals(run.notified, [['league-b-claim-1', 'league-b-claim-2']], 'notified batches')
})

Deno.test('two empty batches in a row end the run', async () => {
  const run = batches([['claim-1'], [], [], ['never-fetched']])
  const rows = await drainDueClaims(run.processBatch, run.onBatch)
  assertEquals(rows, ['claim-1'], 'processed rows')
  assertEquals(run.calls(), 3, 'batch calls')
})

Deno.test('every non-empty batch is notified as it lands and an empty one never is', async () => {
  const run = batches([['claim-1', 'claim-2'], ['claim-3'], [], ['claim-4'], [], []])
  const rows = await drainDueClaims(run.processBatch, run.onBatch)
  assertEquals(rows, ['claim-1', 'claim-2', 'claim-3', 'claim-4'], 'processed rows')
  assertEquals(run.notified, [['claim-1', 'claim-2'], ['claim-3'], ['claim-4']], 'notified batches')
})

Deno.test('the batch backstop bounds a run that never comes back empty', async () => {
  let calls = 0
  const rows = await drainDueClaims(async () => [`claim-${++calls}`], async () => {})
  assertEquals(calls, MAX_BATCHES, 'batch calls')
  assertEquals(rows.length, MAX_BATCHES, 'processed rows')
})
