import assert from 'node:assert/strict'

export function retryableWorkFailure(row) {
  const attempts=Number(row.work_attempts)
  const failedResponse=row.status_code===500&&row.worker_status==='failed'
    || row.timed_out===true&&['running','failed'].includes(row.worker_status)
  const connectionFailure=row.status_code==null&&row.worker_status==null&&typeof row.error_msg==='string'&&row.error_msg.length>0
  const expiredReceipt=row.status_code===200&&row.worker_status==='failed'
    &&row.sync_error==='worker did not finish within 10 minutes'
  return (failedResponse||connectionFailure||expiredReceipt)&&Number.isSafeInteger(Number(row.work_id))&&Number(row.work_id)>0
    &&Number.isSafeInteger(attempts)&&attempts>0&&attempts<=3
    &&(['succeeded','running'].includes(row.work_status)||row.work_status==='failed'&&attempts<3)
}

export function assertRetriedWorkCompleted(ids,rows) {
  const statuses=new Map(rows.map(row=>[Number(row.id),row.status]))
  for(const id of ids)assert.equal(statuses.get(Number(id)),'succeeded',`Retried work ${id} must finish successfully`)
  return {checked:ids.length,succeeded:ids.length}
}
