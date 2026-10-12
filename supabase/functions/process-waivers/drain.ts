export const PROCESS_BATCH_LIMIT = 100
// Drain every due claim in one daily run: keep pulling batches until two in a
// row come back empty. The batch cap bounds one loop iteration, not the day's
// total; MAX_BATCHES only backstops a pathological non-terminating loop.
export const MAX_BATCHES = 100

export async function drainDueClaims<Row>(
  processBatch: () => Promise<Row[]>,
  onBatch: (rows: Row[]) => Promise<void>,
): Promise<Row[]> {
  const rows: Row[] = []
  let emptyBatches = 0
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const batchRows = await processBatch()
    if (batchRows.length === 0) {
      // A batch also comes back empty when the claim its first step picked was
      // settled after the candidate scan (a member cancelling it, or a
      // concurrent run finishing that league) while other claims are still
      // due. A fresh batch scans past it, so only a second empty batch in a row
      // means nothing is left that this run can lock.
      emptyBatches += 1
      if (emptyBatches === 2) break
      continue
    }
    emptyBatches = 0
    rows.push(...batchRows)
    // Each batch is already committed by the RPC. Notify as soon as it lands so
    // a worker killed mid-drain leaves at most one batch of applied claims
    // without their notifications, not the whole run.
    await onBatch(batchRows)
  }
  return rows
}
