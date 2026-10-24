import { strict as assert } from 'node:assert'

Deno.test({ name: 'cleanup skips locked old rows while new operational writes continue', ignore: !Deno.args.includes('--local-db'), fn: async () => {
  const db = Deno.env.get('SUPABASE_DB_URL')!
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
  const name = `retention-concurrency-${crypto.randomUUID()}`
  const held = crypto.randomUUID()
  const sql = async (statement: string) => {
    const process = new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' })
    const output = await process.output()
    if (!output.success) throw new Error(new TextDecoder().decode(output.stderr))
    return new TextDecoder().decode(output.stdout).trim().split('\n').at(-1)
  }
  await sql(`INSERT INTO public.sync_runs(id,function_name,started_at,finished_at,status) VALUES
    ('${held}','${name}',now()-interval '9 days',now()-interval '9 days','success'),
    (gen_random_uuid(),'${name}',now()-interval '8 days',now()-interval '8 days','success'),
    (gen_random_uuid(),'${name}',now(),now(),'success')`)
  const blocker = new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = blocker.stdin.getWriter(), reader = blocker.stdout.getReader()
  try {
    await writer.write(new TextEncoder().encode(`BEGIN; SELECT id FROM public.sync_runs WHERE id='${held}' FOR UPDATE; SELECT 'locked';\n`))
    let output = ''
    while (!output.includes('locked')) {
      const next = await reader.read()
      if (next.done) throw new Error('Lock holder exits before acquiring its row')
      output += new TextDecoder().decode(next.value)
    }
    await sql(`SET statement_timeout='2s'; SELECT public.prune_unbounded_history()`)
    assert.equal(await sql(`SELECT count(*) FROM public.sync_runs WHERE function_name='${name}' AND started_at<now()-interval '7 days'`), '1')
    await sql(`SET statement_timeout='2s'; INSERT INTO public.sync_runs(function_name,finished_at,status) VALUES('${name}',now(),'success')`)
    assert.equal(await sql(`SELECT count(*) FROM public.sync_runs WHERE function_name='${name}'`), '3')
  } finally {
    await writer.write(new TextEncoder().encode('COMMIT;\n'))
    await writer.close()
    await reader.cancel()
    reader.releaseLock()
    await blocker.status
    await blocker.stderr.cancel()
  }
  try {
    await sql('SELECT public.prune_unbounded_history()')
    assert.equal(await sql(`SELECT count(*) FROM public.sync_runs WHERE id='${held}'`), '0')
    console.log(JSON.stringify({ passed: 4, lockedRowsSkipped: 1, concurrentWrite: true }))
  } finally { await sql(`DELETE FROM public.sync_runs WHERE function_name='${name}'`) }
} })
