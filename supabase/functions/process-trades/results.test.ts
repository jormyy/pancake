import { partitionTradeResults, tradeFailureMessage } from './results.ts'

const row = (status: string) => ({
  trade_id: '11111111-1111-4111-8111-111111111111',
  status,
  error_code: status === 'completed' ? null : '40001',
  error_message: status === 'completed' ? null : 'retry me',
})

Deno.test('trade processor partitions only declared result states', () => {
  const partitioned = partitionTradeResults([
    row('completed'),
    row('expired_terminal_failure'),
    row('failed_retryable'),
  ])

  if (partitioned.completed.length !== 1) throw new Error('completed result was not preserved')
  if (partitioned.terminalFailures.length !== 1) throw new Error('terminal failure was not preserved')
  if (partitioned.retryableFailures.length !== 1) throw new Error('retryable failure was not preserved')
  if (!tradeFailureMessage(partitioned.retryableFailures[0]).includes('retry me')) {
    throw new Error('failure detail was not retained for observability')
  }
})

Deno.test('trade processor rejects an undeclared result state', () => {
  let error: unknown
  try {
    partitionTradeResults([row('silently_ignored')])
  } catch (caught) {
    error = caught
  }
  if (!(error instanceof Error) || !error.message.includes('Unexpected trade processor status')) {
    throw new Error('undeclared processor state did not escalate')
  }
})
