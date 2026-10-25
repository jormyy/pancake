export const PROCESS_BATCH_LIMIT = 100
export const MAX_BATCHES = 100

type RetryClock = { sleep: (milliseconds: number) => Promise<void>; now: () => number }

export async function drainDueClaims<Row>(
  processBatch: () => Promise<Row[]>,
  countDue: () => Promise<number> = async () => 0,
  clock: RetryClock = { sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), now: Date.now },
): Promise<Row[]> {
  const rows: Row[] = []
  const deadline = clock.now() + 30000
  while (true) {
    let emptyBatches = 0
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const batchRows = await processBatch()
      if (batchRows.length === 0) {
        emptyBatches += 1
        if (emptyBatches === 2) break
      } else {
        emptyBatches = 0
        rows.push(...batchRows)
      }
    }
    if (await countDue() === 0) return rows
    if (clock.now() >= deadline) throw new Error('Unprocessed due waiver claims remain after retries.')
    await clock.sleep(1000)
  }
}
