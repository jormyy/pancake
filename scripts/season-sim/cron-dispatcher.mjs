import assert from 'node:assert/strict'
import path from 'node:path'
import { appendFile } from 'node:fs/promises'
import { delay, miniRoot, originUrl } from './common.mjs'
import { dispatch } from './dispatch.mjs'
import { sqlJson } from './local-stack.mjs'

export function canAdvanceWorkers(pendingRows, state, at) {
  const unstarted = pendingRows.some(row => !['running', 'success', 'failed'].includes(row.worker_status))
  const running = pendingRows.filter(row => row.worker_status === 'running').length
  return !unstarted && running === state.active && state.active > 0 && state.active === state.sleeping && state.fetches === 0 && state.nextAt > at
}

export function cronDispatcher(onOutcome) {
  const pending = new Map()
  const enqueue = async statement => {
    for (const row of await dispatch(statement, { optional: true, defer: true })) pending.set(row.id, row)
  }
  const settle = async at => {
    const deadline = Date.now() + 120000
    for (;;) {
      let pendingRows = []
      if (pending.size) {
        const results = await sqlJson(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT i.id,i.function_name,i.worker_status,i.error_message,n.status_code,n.timed_out,n.error_msg,n.content FROM public.edge_invocations i LEFT JOIN net._http_response n ON n.id=i.request_id WHERE i.id IN (${[...pending.keys()].join(',')})) r`, 'Pending production dispatches')
        pendingRows = results
        for (const row of results) {
          if (row.status_code == null && row.error_msg == null) continue
          await appendFile(path.join(miniRoot, 'evidence/dispatch.jsonl'), `${JSON.stringify({ statement: pending.get(row.id).statement, ...row })}\n`)
          pending.delete(row.id)
          await onOutcome(row)
        }
      }
      const response = await fetch(`${originUrl('edge')}/health`, { redirect: 'error' })
      assert.ok(response.ok, 'Local runtime health read succeeds')
      const state = await response.json()
      if (!pending.size && !state.active) return { nextAt: null }
      if (canAdvanceWorkers(pendingRows.filter(row => pending.has(row.id)), state, at)) return { nextAt: state.nextAt }
      assert.ok(Date.now() < deadline, `Production workers do not settle at ${new Date(at).toISOString()}: ${JSON.stringify({ pending: [...pending.keys()], ...state })}`)
      await delay(5)
    }
  }
  return { enqueue, settle }
}
