import assert from 'node:assert/strict'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'

async function verifyTradeActivation(mode: 'accept' | 'worker') {
  const api = Deno.env.get('SUPABASE_URL')!
  const db = Deno.env.get('SUPABASE_DB_URL')!
  for (const endpoint of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))
  const admin = createClient(api, Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const client = createClient(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const league = crypto.randomUUID(), season = crypto.randomUUID(), draft = crypto.randomUUID(), trade = crypto.randomUUID()
  const members = [crypto.randomUUID(), crypto.randomUUID()], players = [crypto.randomUUID(), crypto.randomUUID()]
  const users: string[] = []
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  async function sql(statement: string) {
    const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', statement], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
    return new TextDecoder().decode(result.stdout).trim()
  }
  try {
    const password = crypto.randomUUID()
    const emails = [crypto.randomUUID() + '@example.test', crypto.randomUUID() + '@example.test']
    for (const email of emails) {
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      assert.equal(created.error, null)
      users.push(created.data.user!.id)
    }
    await sql(`BEGIN;
      INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,trade_veto_mode)
        VALUES(${quote(league)},'Trade activation',${quote(league)},${quote(users[0])},'drafting',1,'disabled');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9535,true);
      ${members.map((member, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(users[index])},'${index ? 'manager' : 'commissioner'}','Activation ${index}');`).join('\n')}
      INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
        VALUES(${quote(draft)},${quote(league)},${quote(season)},'snake','completed',false,1);
      ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(player)},'Activation',${quote(player)},'PG',ARRAY['PG'],0,1);
        INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${quote(league)},${quote(season)},${quote(members[0])},${quote(player)},'draft');`).join('\n')}
      INSERT INTO snake_draft_picks(draft_id,member_id,round,pick_in_round,overall_pick,player_id,picked_at)
        VALUES(${quote(draft)},${quote(members[0])},1,1,1,${quote(players[0])},now());
      INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,expires_at,veto_window_expires_at)
        VALUES(${quote(trade)},${quote(league)},${quote(season)},${quote(members[0])},${quote(members[1])},'${mode === 'worker' ? 'accepted' : 'pending'}',now()+interval '1 day',now()-interval '1 hour');
      INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
        VALUES(${quote(trade)},${quote(members[0])},0,true,now()),(${quote(trade)},${quote(members[1])},1,false,${mode === 'worker' ? 'now()' : 'NULL'});
      INSERT INTO trade_items(trade_id,side,player_id,from_member_id,to_member_id)
        VALUES(${quote(trade)},'proposer',${quote(players[0])},${quote(members[0])},${quote(members[1])});
      COMMIT;`)
    const blocked = await admin.rpc('activate_rookie_draft_league_atomic', { p_draft_id: draft })
    assert.equal(blocked.error, null)
    assert.equal(blocked.data, false)
    if (mode === 'accept') {
      const session = await client.auth.signInWithPassword({ email: emails[1], password })
      assert.equal(session.error, null)
      const { handleApiRoute } = await import('../api/router.ts')
      const response = await handleApiRoute(new Request(`${api}/functions/v1/api/trades/${trade}/accept`, {
        method: 'POST', headers: { authorization: `Bearer ${session.data.session!.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ memberId: members[1] }),
      }))
      assert.equal(response.status, 200, await response.text())
    } else {
      let handler: (request: Request) => Promise<Response> = () => { throw new Error('Worker did not register') }
      const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
      Object.defineProperty(Deno, 'serve', { value: (callback: typeof handler) => { handler = callback } })
      try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
      const response = await handler(new Request(`${api}/functions/v1/process-trades`, {
        method: 'POST', headers: { 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: '{}',
      }))
      assert.equal(response.status, 200, await response.text())
    }
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${quote(trade)}`), 'completed')
    assert.equal(await sql(`SELECT status FROM leagues WHERE id=${quote(league)}`), 'active', `${mode} activates the draft after the trade clears its last overage`)
    assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE member_id=${quote(members[0])}`), '1')
    assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE member_id=${quote(members[1])}`), '1')
    console.log(JSON.stringify({ mode, passed: 7, separateActivationTransaction: true }))
  } finally {
    await sql(`DELETE FROM snake_draft_picks WHERE draft_id=${quote(draft)}; DELETE FROM drafts WHERE id=${quote(draft)}; DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM players WHERE id IN (${players.map(quote).join(',')});`)
    await client.auth.signOut()
    for (const id of users) assert.equal((await admin.auth.admin.deleteUser(id)).error, null)
  }
}

for (const mode of ['accept', 'worker'] as const) {
  Deno.test({
    name: `${mode} activates a rookie league after the last overage clears`,
    ignore: !Deno.env.get('SUPABASE_DB_URL'),
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => verifyTradeActivation(mode),
  })
}
