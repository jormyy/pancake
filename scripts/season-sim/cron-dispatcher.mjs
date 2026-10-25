import assert from 'node:assert/strict'
import path from 'node:path'
import { appendFile } from 'node:fs/promises'
import { delay, miniRoot, originUrl } from './common.mjs'
import { dispatch } from './dispatch.mjs'
import { sqlJson } from './local-stack.mjs'
import { createStallProbe } from './stall-probe.mjs'

export function canAdvanceWorkers(pendingRows, state, at) {
  const unstarted = pendingRows.some(row => !['running', 'success', 'failed'].includes(row.worker_status))
  const starting = pendingRows.some(row => !['running', 'success', 'failed'].includes(row.worker_status)&&row.queue_pending!==true)
  const running = pendingRows.filter(row => row.worker_status === 'running').length
  if (!unstarted && running === 0 && state.active === 0) return true
  return !starting && running === state.active && state.active > 0 && state.active === state.sleeping && state.fetches === 0 && state.nextAt > at
}

export function cronDispatcher(onOutcome, { enqueueWork=dispatch, query=sqlJson, health=async()=>{
  const response=await fetch(`${originUrl('edge')}/health`,{redirect:'error'})
  assert.ok(response.ok,'Local runtime health read succeeds')
  return response.json()
}, probe=createStallProbe(), recordOutcome=row=>appendFile(path.join(miniRoot,'evidence/dispatch.jsonl'),`${JSON.stringify(row)}\n`) }={}) {
  const pending = new Map()
  const enqueue = async statement => {
    const rows=await enqueueWork(statement, { optional: true, defer: true })
    for (const row of rows) pending.set(row.id, row)
    probe.watch(rows)
  }
  const settle = async (at, waitForResponses = false) => {
    const deadline = Date.now() + 120000
    try{for (;;) {
      let pendingRows = []
      if (pending.size) {
        const results = await query(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT i.id,i.function_name,i.worker_status,i.error_message,n.status_code,n.timed_out,n.error_msg,n.content,(queued.id IS NOT NULL) AS queue_pending FROM public.edge_invocations i LEFT JOIN net._http_response n ON n.id=i.request_id LEFT JOIN net.http_request_queue queued ON queued.id=i.request_id WHERE i.id IN (${[...pending.keys()].join(',')})) r`, 'Pending production dispatches')
        pendingRows = results
        probe.watch(results)
        void probe.check()
        for (const row of results) {
          if (row.status_code == null && row.error_msg == null) continue
          await recordOutcome({ statement: pending.get(row.id).statement, ...row })
          pending.delete(row.id)
          probe.finish(row.id)
          await onOutcome(row)
        }
      }
      const state = await health()
      if (!pending.size && !state.active) return { nextAt: null }
      if (!waitForResponses && canAdvanceWorkers(pendingRows.filter(row => pending.has(row.id)), state, at)) return { nextAt: state.active ? state.nextAt : null }
      assert.ok(Date.now() < deadline, `Production workers do not settle at ${new Date(at).toISOString()}: ${JSON.stringify({ pending: [...pending.keys()], ...state })}`)
      await delay(5)
    }}catch(error){await probe.close();throw error}
  }
  return { enqueue, settle, drain: at => settle(at, true), close:()=>probe.close() }
}
