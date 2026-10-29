import assert from 'node:assert/strict'

export function retryableWorkFailure(row) {
  const failedResponse=row.status_code===500&&row.worker_status==='failed'
    || row.timed_out===true&&row.worker_status==='running'
  return failedResponse&&Number.isSafeInteger(Number(row.work_id))&&Number(row.work_id)>0
    &&Number(row.work_attempts)>0
    &&(row.work_status==='succeeded'||['failed','running'].includes(row.work_status)&&Number(row.work_attempts)<3)
}

export function assertRetriedWorkCompleted(ids,rows) {
  const statuses=new Map(rows.map(row=>[Number(row.id),row.status]))
  for(const id of ids)assert.equal(statuses.get(Number(id)),'succeeded',`Retried work ${id} must finish successfully`)
  return {checked:ids.length,succeeded:ids.length}
}
