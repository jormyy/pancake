import assert from 'node:assert/strict'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'

let workerHandler: ((request: Request) => Promise<Response>) | undefined

async function verifyTradeActivation(mode: 'accept' | 'worker', draftStatus: 'completed' | 'cancelled') {
  const api = Deno.env.get('SUPABASE_URL')!
  const db = Deno.env.get('SUPABASE_DB_URL')!
  for (const endpoint of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))
  const admin = createClient(api, Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const client = createClient(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
  const league = crypto.randomUUID(), season = crypto.randomUUID(), draft = crypto.randomUUID(), pick = crypto.randomUUID()
  let trade: string
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
        VALUES(${quote(league)},'Trade activation',${quote(league)},${quote(users[0])},'drafting',1,'${mode === 'worker' ? 'member_vote' : 'disabled'}');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9535,true);
      ${members.map((member, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(member)},${quote(league)},${quote(users[index])},'${index ? 'manager' : 'commissioner'}','Activation ${index}');`).join('\n')}
      INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
        VALUES(${quote(draft)},${quote(league)},${quote(season)},'snake','${draftStatus}',false,1);
      ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(player)},'Activation',${quote(player)},'PG',ARRAY['PG'],0,1);`).join('\n')}
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
        VALUES(${quote(league)},${quote(season)},${quote(members[0])},${quote(players[0])},'draft');
      INSERT INTO snake_draft_picks(draft_id,member_id,round,pick_in_round,overall_pick,player_id,picked_at)
        VALUES(${quote(draft)},${quote(members[0])},1,1,1,${quote(players[0])},now());
      INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
        VALUES(${quote(pick)},${quote(league)},9536,1,${quote(members[1])},${quote(members[1])});
      COMMIT;`)
    const proposed = await admin.rpc('propose_trade_atomic', {
      p_league_id: league, p_league_season_id: season, p_proposer_member_id: members[0], p_recipient_member_id: members[1],
      p_offer_player_ids: [players[0]], p_request_player_ids: [], p_offer_pick_ids: [], p_request_pick_ids: [pick],
    })
    assert.equal(proposed.error, null)
    trade = proposed.data!
    if (mode === 'worker') {
      const accepted = await admin.rpc('accept_trade_atomic', { p_trade_id: trade, p_accepting_member_id: members[1] })
      assert.equal(accepted.error, null)
    }
    await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${quote(league)},${quote(season)},${quote(members[0])},${quote(players[1])},'draft');
      UPDATE trades SET veto_window_expires_at=now()-interval '1 hour' WHERE id=${quote(trade)};`)
    const illegalOffer = await admin.rpc('submit_trade_offer_atomic', {
      p_user_id: users[0], p_request_id: crypto.randomUUID(), p_member_id: members[0], p_action: 'propose',
      p_payload: { leagueId: league, leagueSeasonId: season, recipientMemberId: members[1], offerFaabAmount: 1, requestFaabAmount: 1 },
    })
    assert.equal(illegalOffer.error?.code, 'PT409', JSON.stringify(illegalOffer.error))
    const blocked = await admin.rpc('activate_rookie_draft_league_atomic', { p_draft_id: draft })
    assert.equal(blocked.error, null)
    assert.equal(blocked.data, false)
    if (mode === 'accept') {
      const session = await client.auth.signInWithPassword({ email: emails[1], password })
      assert.equal(session.error, null)
      const { handleApiRoute } = await import('../api/router.ts')
      const response = await handleApiRoute(new Request(`${api}/functions/v1/api/trades/${trade}/accept`, {
        method: 'POST', headers: { authorization: `Bearer ${session.data.session!.access_token}`, 'content-type': 'application/json', 'x-request-id': crypto.randomUUID() },
        body: JSON.stringify({ memberId: members[1] }),
      }))
      assert.equal(response.status, 200, await response.text())
      assert.equal(await sql(`SELECT status FROM trades WHERE id=${quote(trade)}`), 'accepted')
      assert.equal(await sql(`SELECT status FROM leagues WHERE id=${quote(league)}`), 'drafting')
    }
    {
      if (!workerHandler) {
        const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
        Object.defineProperty(Deno, 'serve', { value: (callback: typeof workerHandler) => { workerHandler = callback } })
        try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
      }
      assert.ok(workerHandler)
      const response = await workerHandler(new Request(`${api}/functions/v1/process-trades`, {
        method: 'POST', headers: { 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: '{}',
      }))
      assert.equal(response.status, 200, await response.text())
    }
    assert.equal(await sql(`SELECT status FROM trades WHERE id=${quote(trade)}`), 'completed')
    assert.equal(await sql(`SELECT status FROM leagues WHERE id=${quote(league)}`), 'active', `${mode} activates the draft after the trade clears its last overage`)
    assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE member_id=${quote(members[0])}`), '1')
    assert.equal(await sql(`SELECT count(*) FROM roster_players WHERE member_id=${quote(members[1])}`), '1')
    console.log(JSON.stringify({ mode, draftStatus, passed: 10, separateActivationTransaction: true }))
  } finally {
    await sql(`DELETE FROM snake_draft_picks WHERE draft_id=${quote(draft)}; DELETE FROM drafts WHERE id=${quote(draft)}; DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM players WHERE id IN (${players.map(quote).join(',')});`)
    await client.auth.signOut()
    for (const id of users) assert.equal((await admin.auth.admin.deleteUser(id)).error, null)
  }
}

for (const mode of ['accept', 'worker'] as const) for (const draftStatus of ['completed', 'cancelled'] as const) {
  Deno.test({
    name: `${mode} waits for worker execution before activating a rookie league with a ${draftStatus} draft`,
    ignore: !Deno.env.get('SUPABASE_DB_URL'),
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => verifyTradeActivation(mode, draftStatus),
  })
}
