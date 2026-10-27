import { strict as assert } from 'node:assert'

const databaseUrl = Deno.env.get('WORK_QUEUE_TEST_DB_URL')
Deno.test({ name: 'the shared worker runtime completes a claimed item through real database RPCs', ignore: !databaseUrl, fn: async () => {
  const target = new URL(databaseUrl!)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
  assert.equal(target.port, '59322')
  const { runEdgeInvocation } = await import('../_shared/syncRuns.ts')
  const { supabase, requiredSecretKey } = await import('../_shared/supabase.ts')
  const { workFetch } = await import('../_shared/workContext.ts')
  const kind = 'worker-test-' + crypto.randomUUID()
  const player = crypto.randomUUID()
  const sql = async (command: string) => {
    const result = await new Deno.Command('psql', { args: [databaseUrl!, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', command], stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
    return new TextDecoder().decode(result.stdout).trim()
  }
  let item: { id: number; invocation_key: string } | undefined
  try {
    const result = await sql(`
      SET app.supabase_url='http://127.0.0.1:1'; SET app.edge_internal_token='local-worker-probe';
      INSERT INTO private.work_kinds(kind,function_name) VALUES('${kind}','sync-players');
      SELECT private.work_enqueue('${kind}','runtime') AS ignored;
      DO $$ DECLARE work private.work_items%ROWTYPE; BEGIN
        PERFORM private.work_claim(500);
        SELECT * INTO work FROM private.work_items WHERE kind='${kind}';
        PERFORM private.work_execute(work.id,work.lease_token);
      END $$;
      SELECT json_build_object('id',id,'invocation_key',invocation_key) FROM private.work_items WHERE kind='${kind}';
    `)
    item = JSON.parse(result.split('\n').find(line => line.startsWith('{'))!)
    assert.ok(item?.invocation_key)
    const request = new Request('http://127.0.0.1/worker', { headers: { 'x-pancake-invocation-id': item.invocation_key, 'x-pancake-work-id': String(item.id) } })
    const response = await runEdgeInvocation('sync-players', request, async () => {
      const { error } = await supabase.from('players').insert({ id: player, first_name: 'Synthetic', last_name: kind, position: 'PG' })
      if (error) throw error
      await sql(`UPDATE private.work_items SET lease_until=now()-interval '1 second' WHERE id=${item!.id}`)
      const expired = await workFetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/players?id=eq.${player}`, {
        method: 'PATCH', headers: { apikey: requiredSecretKey(), Authorization: `Bearer ${requiredSecretKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: 'Stale' }), signal: AbortSignal.timeout(5000),
      })
      assert.equal(expired.status, 409)
      assert.equal((await expired.json()).code, 'PT409')
      await sql(`UPDATE private.work_items SET lease_until=now()+interval '90 seconds' WHERE id=${item!.id}`)
      return Response.json({ ok: true })
    })
    assert.equal(response.status, 200)
    assert.equal(await sql(`SELECT status FROM private.work_items WHERE id=${item.id}`), 'succeeded')
    assert.equal(await sql(`SELECT count(*) FROM public.league_events WHERE detail->>'work_id'='${item.id}' AND kind='work.succeeded'`), '1')
    await assert.rejects(runEdgeInvocation('sync-players', request, async () => Response.json({ ok: true })))
    assert.equal(await sql(`SELECT count(*) FROM public.league_events WHERE detail->>'work_id'='${item.id}'`), '1')
  } finally {
    await sql(`DELETE FROM public.players WHERE id='${player}'; DELETE FROM private.work_items WHERE kind='${kind}'; DELETE FROM private.work_kinds WHERE kind='${kind}';`)
  }
} })
