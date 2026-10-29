import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../_shared/database.ts'

Deno.test({
  name: 'committed league versions reach the authenticated polling endpoint exactly once',
  ignore: !Deno.env.get('SUPABASE_DB_URL'),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const api = Deno.env.get('SUPABASE_URL')!
    const db = Deno.env.get('SUPABASE_DB_URL')!
    assert.equal(new URL(api).hostname, '127.0.0.1')
    assert.equal(new URL(db).hostname, '127.0.0.1')
    assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '59122')
    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    const admin = createClient<Database>(api, Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!, options)
    const client = createClient<Database>(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, options)
    const league = crypto.randomUUID()
    const member = crypto.randomUUID()
    let user: string | undefined
    const sql = async (command: string, expected = 0) => {
      const result = await new Deno.Command('psql', { args: [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', command], stdout: 'piped', stderr: 'piped' }).output()
      assert.equal(result.code, expected, new TextDecoder().decode(result.stderr))
      return new TextDecoder().decode(result.stdout).trim()
    }
    try {
      const email = `version-${league}@example.test`
      const password = `${crypto.randomUUID()}!aA1`
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      assert.ifError(created.error)
      user = created.data.user!.id
      const login = await client.auth.signInWithPassword({ email, password })
      assert.ifError(login.error)
      const token = login.data.session!.access_token
      const inserted = await admin.from('leagues').insert({ id: league, name: 'Live version fixture', slug: league, commissioner_id: user })
      assert.ifError(inserted.error)
      const joined = await admin.from('league_members').insert({ id: member, league_id: league, user_id: user, role: 'commissioner' })
      assert.ifError(joined.error)
      const before = BigInt(await sql(`SELECT version FROM public.league_versions WHERE league_id='${league}'`))
      assert.equal(await sql("SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='league_change_hints'"), '1')
      await sql(`BEGIN; UPDATE public.leagues SET name='Changed version fixture' WHERE id='${league}'; UPDATE public.league_members SET team_name='Changed team' WHERE id='${member}'; COMMIT`)
      const expected = (before + 1n).toString()
      assert.equal(await sql(`SELECT version FROM public.league_versions WHERE league_id='${league}'`), expected)
      assert.equal(await sql(`SELECT revision FROM public.league_change_hints WHERE league_id='${league}' AND topic='version'`), expected)
      assert.equal(await sql(`SELECT count(*) FROM public.league_changes WHERE league_id='${league}' AND version>${before}`), '1')
      await sql(`BEGIN; UPDATE public.leagues SET name='Rolled back' WHERE id='${league}'; SELECT 1/0; COMMIT`, 1)
      assert.equal(await sql(`SELECT version FROM public.league_versions WHERE league_id='${league}'`), expected)
      const { handleApiRoute } = await import('../router.ts')
      const request = (since: string) => new Request(`${api}/functions/v1/api/version?league=${league}&since=${since}`, { headers: { Authorization: `Bearer ${token}` } })
      const changed = await handleApiRoute(request(before.toString()))
      assert.equal(changed.status, 200)
      const body = await changed.json()
      assert.equal(body.version, expected)
      assert.equal(body.changes.length, 1)
      assert.equal(body.changes[0].topic, 'batch')
      const unchanged = await handleApiRoute(request(expected))
      assert.deepEqual(await unchanged.json(), { version: expected, changes: [] })
      console.log(JSON.stringify({ committedBumps: 1, rollbackBumps: 0, actualEndpoint: true, activeClientRealtime: true }))
    } finally {
      client.realtime.disconnect()
      await sql(`DELETE FROM public.leagues WHERE id='${league}'; DELETE FROM public.league_change_hints WHERE league_id='${league}'`)
      if (user) assert.ifError((await admin.auth.admin.deleteUser(user)).error)
      admin.realtime.disconnect()
    }
  },
})
