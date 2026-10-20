import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { delay, miniRoot } from './common.mjs'
import { sql } from './local-stack.mjs'

export async function dispatch(statement, { optional = false, allowFailure = false } = {}) {
  if (process.env.SEASON_SIM_PRODUCTION_ONLY === '1') {
    for (const query of Array.isArray(statement) ? statement : [statement]) assert.ok(!/invoke_edge_function\s*\(\s*'(?:sync-stats|sync-scores|sync-players|sync-schedule)'/i.test(query), 'Replay forbids direct business maintenance invocations; use production gates')
  }
  const before = Number(await sql('SELECT coalesce(max(id),0) FROM public.edge_invocations'))
  if (Array.isArray(statement)) await Promise.all(statement.map(query => sql(query)))
  else await sql(statement)
  const ids = JSON.parse(await sql(`SELECT coalesce(json_agg(id),'[]') FROM public.edge_invocations WHERE id>${before}`))
  assert.ok(optional || ids.length > 0, `Dispatcher produced no invocation: ${statement}`)
  const outcomes = []
  for (const id of ids) {
    let result
    for (let attempt = 0; attempt < 150; attempt++) {
      result = JSON.parse(await sql(`SELECT row_to_json(r) FROM (SELECT i.id,i.function_name,i.worker_status,i.error_message,n.status_code,n.timed_out,n.error_msg,n.content FROM public.edge_invocations i LEFT JOIN net._http_response n ON n.id=i.request_id WHERE i.id=${Number(id)}) r`))
      if (result.status_code != null || result.error_msg != null) break
      await delay(400)
    }
    await appendFile(path.join(miniRoot, 'evidence/dispatch.jsonl'), `${JSON.stringify({ statement, ...result })}\n`)
    if (!allowFailure) {
      assert.equal(result.status_code, 200, JSON.stringify(result))
      assert.equal(result.worker_status, 'success', JSON.stringify(result))
    }
    outcomes.push(result)
  }
  return outcomes
}
