import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { delay, miniRoot } from './common.mjs'
import { sql } from './local-stack.mjs'

export async function dispatch(statement, { optional = false, allowFailure = false, defer = false } = {}, execute = sql) {
  if (process.env.SEASON_SIM_PRODUCTION_ONLY === '1') {
    for (const query of Array.isArray(statement) ? statement : [statement]) assert.ok(!/invoke_edge_function\s*\(\s*'(?:sync-stats|sync-scores|sync-players|sync-schedule)'/i.test(query), 'Replay forbids direct business maintenance invocations; use production gates')
  }
  let ids
  if (defer && typeof statement === 'string' && statement.split(';').filter(part => part.trim()).every(part => /^\s*SELECT\b/i.test(part))) {
    assert.ok(!statement.includes('$season_sim_dispatch$'))
    ids = JSON.parse(await execute(`DO $season_sim_dispatch$
DECLARE before_id bigint;
BEGIN
  SELECT coalesce(max(id),0) INTO before_id FROM public.edge_invocations;
  ${statement.replace(/(^|;)\s*SELECT\b/gi, '$1 PERFORM')};
  PERFORM set_config('season_sim.dispatch_ids',(SELECT coalesce(json_agg(id),'[]')::text FROM public.edge_invocations WHERE id>before_id),false);
END;
$season_sim_dispatch$;
SELECT current_setting('season_sim.dispatch_ids')`))
  } else {
    const before = Number(await execute('SELECT coalesce(max(id),0) FROM public.edge_invocations'))
    if (Array.isArray(statement)) await Promise.all(statement.map(query => execute(query)))
    else await execute(statement)
    ids = JSON.parse(await execute(`SELECT coalesce(json_agg(id),'[]') FROM public.edge_invocations WHERE id>${before}`))
  }
  assert.ok(optional || ids.length > 0, `Dispatcher produced no invocation: ${statement}`)
  if (defer) return ids.map(id => ({ id, statement }))
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
