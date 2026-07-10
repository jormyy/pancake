export type TradeProcessingResult = {
  trade_id: string
  status: string
  error_code: string | null
  error_message: string | null
}

export type PartitionedTradeResults<Row extends TradeProcessingResult> = {
  completed: Row[]
  terminalFailures: Row[]
  retryableFailures: Row[]
}

export function partitionTradeResults<Row extends TradeProcessingResult>(
  rows: Row[],
): PartitionedTradeResults<Row> {
  const result: PartitionedTradeResults<Row> = {
    completed: [],
    terminalFailures: [],
    retryableFailures: [],
  }

  for (const row of rows) {
    if (row.status === 'completed') result.completed.push(row)
    else if (row.status === 'expired_terminal_failure') result.terminalFailures.push(row)
    else if (row.status === 'failed_retryable') result.retryableFailures.push(row)
    else throw new Error(`Unexpected trade processor status for ${row.trade_id}: ${row.status}`)
  }

  return result
}

export function tradeFailureMessage(row: TradeProcessingResult): string {
  return `Trade ${row.trade_id}: ${row.status}: ${row.error_message ?? row.error_code ?? 'unknown error'}`
}
