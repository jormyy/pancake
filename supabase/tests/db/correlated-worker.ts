import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')!
const database = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname))
assert.ok(['localhost', '127.0.0.1'].includes(new URL(database).hostname))
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { serveInternal } = await import('../../functions/_shared/serve.ts')
const { recordSyncRun } = await import('../../functions/_shared/syncRuns.ts')
const scope = `invocation-probe-${crypto.randomUUID()}`
const nativeServe = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
let server: Deno.HttpServer<Deno.NetAddr> | undefined
let executed = 0
const observations: { key: string | null; started: number; finished: number; mode: string }[] = []
Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
  server = nativeServe({ hostname: '0.0.0.0', port: 0, onListen() {} }, handler)
  return server
} })
try {
  serveInternal(scope, async request => {
    const body = await request.json() as { delayMs?: number; mode: string }
    return await recordSyncRun(scope, async () => {
      executed++
      const observation = { key: request.headers.get('x-pancake-invocation-id'), started: Date.now(), finished: 0, mode: body.mode }
      observations.push(observation)
      if (body.delayMs) await new Promise(resolve => setTimeout(resolve, body.delayMs))
      observation.finished = Date.now()
      if (body.mode === 'throw') throw new Error('synthetic worker exception')
      return {
        result: Response.json({ ok: body.mode !== 'partial' }, { status: body.mode === 'partial' ? 500 : 200 }),
        rowsAffected: body.mode === 'partial' ? 633 : 7,
        failure: body.mode === 'partial' ? 'one synthetic identity conflict' : null,
      }
    }, request)
  })
} finally {
  Object.defineProperty(Deno, 'serve', descriptor)
}
assert.ok(server)
const activeServer = server as Deno.HttpServer<Deno.NetAddr>
const endpoint = `http://127.0.0.1:${activeServer.addr.port}/functions/v1/${scope}`
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
async function sql(command: string): Promise<string> {
  const result = await new Deno.Command('psql', { args: [database, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', command], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 45000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (ready(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for local invocation')
}
async function invocation(key: string) {
  const { data, error } = await supabase.from('edge_invocations').select('*,sync_run_id').eq('invocation_key', key).single()
  if (error) throw error
  return data
}
async function runRow(key: string) {
  const inv = await invocation(key)
  assert.ok(inv.sync_run_id)
  const { data, error } = await supabase.from('sync_runs').select('*').eq('id', inv.sync_run_id).single()
  if (error) throw error
  return data
}
function request(key: string, mode: string, delayMs = 0) {
  return fetch(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-internal-function-token': internalToken, 'x-pancake-invocation-id': key,
  }, body: JSON.stringify({ mode, delayMs }) })
}
async function createInvocation() {
  const key = crypto.randomUUID()
  await sql(`INSERT INTO public.edge_invocations(function_name,invocation_key) VALUES ('${scope}','${key}')`)
  return key
}
try {
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal(executed, 0)
  const key = await createInvocation()
  const responses = await Promise.all([request(key, 'success', 250), request(key, 'success', 250)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 500])
  await Promise.all(responses.map(r => r.text()))
  assert.equal(executed, 1)
  assert.equal((await runRow(key)).rows_affected, 7)
  assert.equal((await runRow(key)).status, 'success')
  console.log(JSON.stringify({ case: 'concurrent duplicate delivery', executed, statuses: responses.map(r => r.status) }))

  const partial = await createInvocation()
  const partialResponse = await request(partial, 'partial')
  assert.equal(partialResponse.status, 500)
  await partialResponse.text()
  await sql(`UPDATE public.edge_invocations SET queued_at=now()-interval '2 minutes' WHERE invocation_key='${partial}'; SELECT private.reconcile_edge_invocations();`)
  const partialRun = await runRow(partial)
  assert.equal(partialRun.rows_affected, 633)
  assert.equal(partialRun.status, 'failed')
  assert.equal(partialRun.error, 'one synthetic identity conflict')
  const thrown = await createInvocation()
  const thrownResponse = await request(thrown, 'throw')
  assert.equal(thrownResponse.status, 500)
  await thrownResponse.text()
  assert.equal((await runRow(thrown)).error, 'synthetic worker exception')
  console.log(JSON.stringify({ case: 'partial and thrown failures', partialRows: partialRun.rows_affected, partialError: partialRun.error }))

  const workerHost = Deno.env.get('E2E_INVOCATION_WORKER_HOST') ?? 'host.docker.internal'
  assert.ok(['host.docker.internal', 'host.lima.internal'].includes(workerHost))
  const base = `http://${workerHost}:${activeServer.addr.port}`
  await sql(`BEGIN; SELECT set_config('app.supabase_url','${base}',true); SELECT set_config('app.edge_internal_token','${internalToken}',true); SELECT public.invoke_edge_function('${scope}','{"mode":"delayed","delayMs":33000}'); COMMIT;`)
  const delayedKey = await waitFor(async () => {
    const { data, error } = await supabase.from('edge_invocations').select('invocation_key').eq('function_name', scope).not('request_id', 'is', null).single()
    if (error) throw error
    return data.invocation_key
  }, value => Boolean(value))
  assert.ok(delayedKey)
  const delayed = await invocation(delayedKey)
  await waitFor(() => sql(`SELECT COALESCE(timed_out,false)::text FROM net._http_response WHERE id=${delayed.request_id}`), value => value === 'true', 40000)
  assert.ok(observations.some(row => row.key === delayedKey), 'pg_net reaches the real worker')
  assert.equal((await invocation(delayedKey)).worker_status, 'running', 'transport times out before worker finishes')
  await sql(`UPDATE public.edge_invocations SET queued_at=now()-interval '2 minutes' WHERE invocation_key='${delayedKey}'; SELECT private.reconcile_edge_invocations();`)
  assert.equal((await runRow(delayedKey)).status, 'running')
  await waitFor(() => invocation(delayedKey), row => row.worker_status === 'success')
  await sql('SELECT private.reconcile_edge_invocations();')
  const delayedRun = await runRow(delayedKey)
  assert.equal(delayedRun.status, 'success')
  assert.equal(delayedRun.rows_affected, 7)
  assert.match((await invocation(delayedKey)).error_message ?? '', /tim.*out/i)
  const observation = observations.find(row => row.key === delayedKey)!
  assert.ok(observation.finished - observation.started >= 33000)
  const { data: runs, error } = await supabase.from('sync_runs').select('id,status').in('function_name', [scope, `cron:${scope}`])
  assert.equal(error, null)
  assert.equal(runs?.length, 4, 'one canonical outcome for each of four actual executions')
  assert.equal(runs?.filter(row => row.status === 'success').length, 2)
  console.log(JSON.stringify({ case: 'real pg_net timeout then successful worker', elapsedMs: observation.finished - observation.started, worker: delayedRun.status, canonicalRows: runs?.length }))
  const dailyCommand = `BEGIN; SELECT set_config('app.supabase_url','${base}',true); SELECT set_config('app.edge_internal_token','${internalToken}',true); SELECT public.invoke_edge_function_at_et_time('${scope}',0,0); COMMIT;`
  await Promise.all([sql(dailyCommand), sql(dailyCommand)])
  const daily = await waitFor(async () => {
    const { data, error } = await supabase.from('edge_invocations').select('*').eq('dispatch_job_key', `et-time:${scope}`)
    if (error) throw error
    assert.equal(data?.length, 1, 'two concurrent sessions queue exactly one daily attempt')
    return data[0]
  }, row => row.worker_status === 'success')
  assert.ok(daily.invocation_key)
  assert.equal(executed, 5)
  console.log(JSON.stringify({ case: 'two real SQL sessions race daily claim', invocations: 1, executed }))
} finally {
  await activeServer.shutdown()
  await sql(`DELETE FROM public.sync_runs WHERE function_name IN ('${scope}','cron:${scope}'); DELETE FROM net._http_response WHERE id IN (SELECT request_id FROM public.edge_invocations WHERE function_name='${scope}'); DELETE FROM public.edge_invocations WHERE function_name='${scope}'; DELETE FROM public.cron_dispatch_state WHERE job_key='et-time:${scope}';`)
  console.log(JSON.stringify({ cleanup: 'owned invocation fixtures removed' }))
}
