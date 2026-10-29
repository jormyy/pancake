import { sql } from '../season-sim/local-stack.mjs'

export async function trackProductionRetry(outcome, report, query = sql) {
  const id = Number(outcome.id)
  if (!Number.isSafeInteger(id) || id <= 0) return false
  const rows = JSON.parse(await query(`SELECT coalesce(json_agg(work_row),'[]') FROM (
    SELECT work.id,work.status,work.attempts,work.due_at,work.due_at>now() AS future
    FROM private.work_items work JOIN edge_invocations invocation ON invocation.work_item_id=work.id
    WHERE invocation.id=${id}
  ) work_row`))
  const work = rows[0]
  if (!work) return false
  const previous = report.productionRetries?.find(row => row.workItemId === work.id)
  if (previous && work.status === 'succeeded' && outcome.worker_status === 'success') {
    previous.recovered = true
    previous.recoveredBy = id
    previous.finalAttempts = work.attempts
  }
  if (outcome.worker_status !== 'failed' || work.status !== 'failed' || work.attempts >= 3 || work.future !== true) return false
  report.productionRetries ??= []
  const row = previous ?? { workItemId: work.id, recovered: false, failures: [] }
  if (!previous) report.productionRetries.push(row)
  row.failures.push({ invocationId: id, attempts: work.attempts, dueAt: work.due_at, error: outcome.sync_error ?? outcome.error_message ?? `HTTP ${outcome.status_code ?? 'unknown'} worker failure` })
  return true
}

export function retriesRecovered(report) {
  return (report.productionRetries ?? []).every(row => row.recovered === true)
}
