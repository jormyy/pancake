// Real pending acceptance interleavings, legal pending actions, authorization and rollback controls.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const allActions = ['edit', 'edit-multi', 'taxi', 'taxi-multi']
const selection = process.argv.find((arg) => arg.startsWith('--actions='))?.slice('--actions='.length)
const actions = selection ? selection.split(',') : allActions
assert(actions.length && actions.every((action) => allActions.includes(action)))
const prefix = `owned-pending-accept-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`
const parse = (value) => JSON.parse(value)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions = [], fixtures = []
const print = (stage, evidence) => console.log(JSON.stringify({ stage, ...evidence }))

class Session {
  constructor(name) {
    this.pending = null; this.buffer = ''; this.lines = []; this.stderr = ''; this.ended = false
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      env: { ...process.env, PGAPPNAME: `${prefix}-${name}`,
        PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=18000 -c idle_in_transaction_session_timeout=30000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let at
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, ''); this.buffer = this.buffer.slice(at + 1)
        if (this.pending && line === this.pending.marker) {
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer)
          const output = this.lines.join('\n').trim(); this.lines = []; pending.resolve(output)
        } else this.lines.push(line)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.closed = new Promise((resolve) => {
      const end = (code, error) => {
        this.ended = true
        if (this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.reject(error ?? new Error(`Own SQL connection closes (${code}): ${this.stderr}`)); this.pending = null
        }
        resolve(code)
      }
      this.child.on('error', (error) => end(-1, error)); this.child.on('close', (code) => end(code))
    })
  }
  query(statement) {
    assert.equal(this.pending, null); assert.equal(this.ended, false)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); reject(new Error('Own SQL query exceeds 25 seconds')) }, 25000)
      this.pending = { marker, resolve, reject, timer }
      this.child.stdin.write(`${statement}\nSELECT ${quote(marker)};\n`)
    })
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      if (this.pending) this.child.kill('SIGTERM')
      else if (!this.ended) await this.query('ROLLBACK;').catch(() => {})
      this.child.stdin.end(); await this.closed
    })()
    return this.closePromise
  }
}
const root = new Session('inspector')
const open = (name) => { const session = new Session(name); sessions.push(session); return session }

// These session-local SECURITY INVOKER helpers return actual SQLSTATE values.
const helpers = `CREATE FUNCTION pg_temp.capture_edit(p_user uuid,p_key uuid,p_member uuid,p_action text,p_payload jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  DECLARE v_id uuid;
  BEGIN
    v_id:=public.submit_trade_offer_atomic(p_user,p_key,p_member,p_action,p_payload);
    RETURN jsonb_build_object('ok',true,'result',v_id,'role',current_user);
  EXCEPTION WHEN query_canceled THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  END $capture$;
  CREATE FUNCTION pg_temp.capture_taxi(p_trade uuid,p_member uuid,p_user uuid,p_players uuid[])
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  BEGIN
    PERFORM public.set_trade_taxi_destinations_atomic(p_trade,p_member,p_players,p_user);
    RETURN jsonb_build_object('ok',true,'role',current_user);
  EXCEPTION WHEN query_canceled THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  END $capture$;
  CREATE FUNCTION pg_temp.capture_complete(p_trade uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  BEGIN
    PERFORM public.complete_accepted_trade_atomic(p_trade);
    RETURN jsonb_build_object('ok',true,'role',current_user);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  END $capture$;
  GRANT EXECUTE ON FUNCTION pg_temp.capture_edit(uuid,uuid,uuid,text,jsonb),
    pg_temp.capture_taxi(uuid,uuid,uuid,uuid[]),pg_temp.capture_complete(uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION pg_temp.capture_edit(uuid,uuid,uuid,text,jsonb),
    pg_temp.capture_taxi(uuid,uuid,uuid,uuid[]) TO authenticated;
  DO $grant$ BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role,authenticated',
      (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
  END $grant$;`

async function fixture(action, control) {
  const f = { action, control, league: randomUUID(), season: randomUUID(),
    users: Array.from({ length: 3 }, () => randomUUID()), members: Array.from({ length: 3 }, () => randomUUID()),
    players: [randomUUID(), randomUUID()], rosters: [randomUUID(), randomUUID()],
    request: randomUUID(), source: null, mayClean: false }
  fixtures.push(f)
  const scopes = [`league:${f.league}`, `season:${f.season}`, ...f.players.map((id) => `player:${id}`)]
  assert.equal(await root.query(`SELECT
    (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))
    +(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)})
    +(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)})
    +(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))
    +(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)}))
    +(SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)}))
    +(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)}))
    +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(scopes)}));`), '0')
  f.mayClean = true
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline,trade_veto_mode,trade_veto_window_hours,taxi_slots)
      VALUES(${quote(f.league)},'Owned accepted completion race',${quote(f.league)},${quote(f.users[0])},'active','faab',NULL,'member_vote',24,3);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${quote(f.members[0])},${quote(f.league)},${quote(f.users[0])},'commissioner','A'),
      (${quote(f.members[1])},${quote(f.league)},${quote(f.users[1])},'manager','B'),
      (${quote(f.members[2])},${quote(f.league)},${quote(f.users[2])},'manager','C');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(f.season)},${quote(f.league)},2162,true);
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(f.league)},${quote(f.season)},id,100 FROM unnest(ARRAY[${list(f.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp,nba_draft_number) VALUES
      (${quote(f.players[0])},'Synthetic',${quote(`From${f.league}`)},'PG',ARRAY['PG'],NULL,0,1),
      (${quote(f.players[1])},'Synthetic',${quote(`Back${f.league}`)},'PG',ARRAY['PG'],NULL,2,NULL);
    INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via,is_on_ir,is_on_taxi) VALUES
      (${quote(f.rosters[0])},${quote(f.players[0])},${quote(f.members[0])},${quote(f.league)},${quote(f.season)},'draft',false,false),
      (${quote(f.rosters[1])},${quote(f.players[1])},${quote(f.members[1])},${quote(f.league)},${quote(f.season)},'draft',false,false);
    COMMIT;`)
  f.multi = action.endsWith('-multi'); f.taxi = action.startsWith('taxi')
  f.expiresAt = new Date(Date.now() + 86400000).toISOString()
  f.items = [{ fromMemberId: f.members[0], toMemberId: f.members[1], playerId: f.players[0] },
    { fromMemberId: f.members[2], toMemberId: f.members[0], faabAmount: 1 }]
  const propose = f.multi
    ? `public.propose_multi_team_trade_atomic(${quote(f.league)},${quote(f.season)},${quote(f.members[0])},ARRAY[${list(f.members)}]::uuid[],${json(f.items)},'Owned accepted source',${quote(f.expiresAt)}::timestamptz)`
    : `public.propose_trade_atomic(${quote(f.league)},${quote(f.season)},${quote(f.members[0])},${quote(f.members[1])},ARRAY[${quote(f.players[0])}]::uuid[],ARRAY[${quote(f.players[1])}]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'Owned accepted source',${quote(f.expiresAt)}::timestamptz,0,0)`
  f.source = await root.query(`BEGIN; SET LOCAL ROLE service_role; SELECT ${propose}; COMMIT;`)
  assert.match(f.source, /^[0-9a-f-]{36}$/)
  // Leave exactly the final recipient unaccepted. The veto window stays open.
  if (f.multi) {
    const prior = parse(await root.query(`BEGIN; SET LOCAL ROLE service_role;
      SELECT public.accept_trade_atomic(${quote(f.source)},${quote(f.members[1])}); COMMIT;`))
    assert.equal(prior.expired, false); assert.equal(prior.allAccepted, false)
  }
  f.finalMember = f.members[f.multi ? 2 : 1]
  f.actor = f.taxi ? 1 : 0
  assert.equal(await root.query(`SELECT status='pending' AND veto_window_expires_at IS NULL
    FROM public.trades WHERE id=${quote(f.source)};`), 't')
  f.payload = { tradeId: f.source, notes: `Owned pending ${action}`, expiresAt: f.expiresAt,
    ...(f.multi ? { participantMemberIds: f.members, items: f.items } : {
      offerPlayerIds: [f.players[0]], requestPlayerIds: [f.players[1]], offerPickIds: [], requestPickIds: [],
      offerFaabAmount: 0, requestFaabAmount: 0 }) }
  return f
}

const stateSql = (f) => `SELECT jsonb_build_object(
  'trades',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.trades t WHERE league_id=${quote(f.league)}),
  'items',(SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM public.trade_items i
    WHERE trade_id IN (SELECT id FROM public.trades WHERE league_id=${quote(f.league)})),
  'participants',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM public.trade_participants p WHERE trade_id=${quote(f.source)}),
  'rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.roster_players r WHERE league_id=${quote(f.league)}),
  'balances',(SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id) FROM public.faab_balances b WHERE league_id=${quote(f.league)}),
  'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM private.trade_offer_requests r WHERE user_id IN (${list(f.users)})),
  'transactions',(SELECT count(*) FROM public.roster_transactions WHERE related_trade_id=${quote(f.source)}),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
  'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})));`

const actionSql = (f, user = f.users[f.actor]) => f.taxi
  ? `SELECT pg_temp.capture_taxi(${quote(f.source)},${quote(f.members[1])},${quote(user)},ARRAY[${quote(f.players[0])}]::uuid[]);`
  : `SELECT pg_temp.capture_edit(${quote(user)},${quote(f.request)},${quote(f.members[0])},${quote(f.action)},${json(f.payload)});`
const pendingDenial = (result, f) => {
  assert.equal(result.ok, false); assert.equal(result.sqlstate, 'P0001')
  assert.match(result.message, f.taxi ? /destinations.*pending|while.*pending/ : /Only pending offers.*edited|no longer pending/)
}
async function waitOnFirstMember(aPid, bPid, settled, f) {
  const deadline = Date.now() + 6000
  let evidence
  while (Date.now() < deadline) {
    evidence = parse(await root.query(`SELECT jsonb_build_object(
      'aPid',${aPid},'bPid',${bPid},'waitType',a.wait_event_type,'waitEvent',a.wait_event,
      'blockingPids',pg_blocking_pids(a.pid),'waitsOnB',${bPid}=ANY(pg_blocking_pids(a.pid)),
      'exactMemberKey',EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks holding
        ON waiting.locktype=holding.locktype AND waiting.classid=holding.classid
        AND waiting.objid=holding.objid AND waiting.objsubid=holding.objsubid
        WHERE waiting.pid=${aPid} AND holding.pid=${bPid}
          AND waiting.locktype='advisory' AND NOT waiting.granted AND holding.granted
          AND waiting.classid=(hashtext(${quote(f.league)})::bigint & 4294967295)::oid
          AND waiting.objid=(hashtext(${quote(f.firstMember)})::bigint & 4294967295)::oid
          AND waiting.objsubid=2)) FROM pg_stat_activity a WHERE a.pid=${aPid};`))
    if (evidence.waitType === 'Lock' && evidence.waitEvent === 'advisory' && evidence.waitsOnB && evidence.exactMemberKey) {
      assert.equal(settled(), false); return evidence
    }
    assert.equal(settled(), false, 'Pending action returns before the actual member-lock interleaving')
    await sleep(25)
  }
  throw new Error(`No exact own member advisory wait: ${JSON.stringify(evidence)}`)
}
const positiveState = (state, before, result, f) => {
  assert.equal(result.ok, true); assert.equal(result.role, 'service_role')
  assert.deepEqual(state.rosters, before.rosters); assert.deepEqual(state.balances, before.balances)
  assert.equal(state.transactions, 0)
  if (f.taxi) {
    assert.deepEqual(state.trades, before.trades); assert.equal(state.receipts.length, 0)
    const incoming = state.items.find((item) => item.player_id === f.players[0])
    assert.equal(incoming.to_taxi, true, 'Successful pending selection visibly chooses taxi')
    assert.equal(incoming.to_member_id, f.members[1])
    assert.equal(before.items.find((item) => item.player_id === f.players[0]).to_taxi, false)
  } else {
    assert.match(result.result, /^[0-9a-f-]{36}$/)
    assert.equal(state.trades.length, 2); assert.equal(state.receipts.length, 1)
    const source = state.trades.find((trade) => trade.id === f.source)
    const replacement = state.trades.find((trade) => trade.id === result.result)
    assert.equal(source.status, 'edited'); assert.equal(source.replaced_by_trade_id, result.result)
    assert.equal(replacement.status, 'pending'); assert.equal(replacement.edited_from_trade_id, f.source)
    assert.equal(replacement.version, source.version + 1)
    assert.equal(state.receipts[0].completed, true); assert.equal(state.receipts[0].result_trade_id, result.result)
    const terms = state.items.filter((item) => item.trade_id === result.result)
    assert.equal(terms.length, 2)
    assert(terms.some((item) => item.player_id === f.players[0] && item.from_member_id === f.members[0] && item.to_member_id === f.members[1]))
    if (f.multi) assert(terms.some((item) => item.faab_amount === 1 && item.from_member_id === f.members[2] && item.to_member_id === f.members[0]))
    else assert(terms.some((item) => item.player_id === f.players[1] && item.from_member_id === f.members[1] && item.to_member_id === f.members[0]))
  }
}

try {
  for (const action of actions) for (const control of ['accept-commits', 'accept-rolls-back', 'pending-action-rolls-back']) {
    const f = await fixture(action, control)
    const a = open(`${action}-${control}-pending`), b = open(`${action}-${control}-accept`)
    await a.query(helpers); await b.query(helpers)
    const before = parse(await root.query(stateSql(f)))
    assert.equal(before.trades.length, 1); assert.equal(before.trades[0].status, 'pending')
    assert.equal(before.receipts.length, 0)
    assert.equal(before.participants.find((row) => row.member_id === f.finalMember).accepted_at, null)

    // Actual ownership rejection under the backend role, not a simulated guard.
    const wrongOwner = parse(await a.query(`BEGIN; SET LOCAL ROLE service_role;
      ${actionSql(f, f.users[2])} ROLLBACK;`))
    assert.equal(wrongOwner.ok, false); assert.equal(wrongOwner.sqlstate, '42501')
    assert.equal(wrongOwner.role, 'service_role')
    assert.match(wrongOwner.message, /Not authorized/)
    assert.deepEqual(parse(await root.query(stateSql(f))), before)

    // Use a real authenticated role and owned JWT subject. The RPC ACL decides access.
    const publicSignature = f.taxi ? 'public.set_trade_taxi_destinations_atomic(uuid,uuid,uuid[],uuid)'
      : 'public.submit_trade_offer_atomic(uuid,uuid,uuid,text,jsonb)'
    const clientMayExecute = await root.query(`SELECT has_function_privilege('authenticated',${quote(publicSignature)},'EXECUTE');`) === 't'
    const rawCall = actionSql(f).replace(/^SELECT /, '').replace(/;$/, '')
    const authenticated = parse(await a.query(`BEGIN; SET LOCAL ROLE authenticated;
      DO $jwt$ BEGIN
        PERFORM set_config('request.jwt.claim.sub',${quote(f.users[f.actor])},true);
        PERFORM set_config('request.jwt.claims',${quote(JSON.stringify({ sub: f.users[f.actor], role: 'authenticated' }))},true);
      END $jwt$;
      SELECT jsonb_build_object('subject',auth.uid(),'result',${rawCall}); ROLLBACK;`))
    assert.equal(authenticated.subject, f.users[f.actor])
    assert.equal(authenticated.result.role, 'authenticated')
    if (clientMayExecute) assert.equal(authenticated.result.ok, true)
    else { assert.equal(authenticated.result.ok, false); assert.equal(authenticated.result.sqlstate, '42501') }
    assert.deepEqual(parse(await root.query(stateSql(f))), before)
    print('actual-identity-controls', { action, control, wrongOwner, clientMayExecute, authenticated })

    const aPid = Number(await a.query('SELECT pg_backend_pid();')), bPid = Number(await b.query('SELECT pg_backend_pid();'))
    let pendingA, aSettled = false
    try {
      // Acceptance's real prefix: final participant row, then first ordered member key.
      f.firstMember = await root.query(`SELECT member_id FROM public.trade_participants
        WHERE trade_id=${quote(f.source)} ORDER BY member_id LIMIT 1;`)
      assert(f.members.includes(f.firstMember))
      await b.query(`BEGIN; DO $prefix$ BEGIN
        PERFORM 1 FROM public.trade_participants WHERE trade_id=${quote(f.source)}
          AND member_id=${quote(f.finalMember)} FOR UPDATE;
        PERFORM pg_advisory_xact_lock(hashtext(${quote(f.league)}),hashtext(${quote(f.firstMember)}));
      END $prefix$;`)
      pendingA = a.query(`BEGIN; SET LOCAL ROLE service_role; ${actionSql(f)}`)
        .then((output) => { aSettled = true; return { output } }, (error) => { aSettled = true; return { error } })
      const waiting = await waitOnFirstMember(aPid, bPid, () => aSettled, f)
      assert.deepEqual(parse(await root.query(stateSql(f))), before)
      print('actual-pending-action-waits-before-acceptance', { action, control, waiting, committedSource: 'pending' })

      let acceptance = null, committedAcceptanceState = null
      if (control !== 'pending-action-rolls-back') {
        assert.equal(await root.query(`SELECT user_id=${quote(f.users[f.multi ? 2 : 1])}
          FROM public.league_members WHERE id=${quote(f.finalMember)};`), 't')
        acceptance = parse(await b.query(`SET LOCAL ROLE service_role;
          SELECT jsonb_build_object('role',current_user,'result',
            public.accept_trade_atomic(${quote(f.source)},${quote(f.finalMember)}));`))
        assert.equal(acceptance.role, 'service_role')
        assert.equal(acceptance.result.expired, false); assert.equal(acceptance.result.allAccepted, true)
        assert.equal(aSettled, false, 'A must wait until the real acceptance transaction ends')
        // Read B's own uncommitted acceptance effects, then compare them with final committed state.
        committedAcceptanceState = parse(await b.query(`RESET ROLE; ${stateSql(f)}`))
        assert.equal(committedAcceptanceState.trades[0].status, 'accepted')
        assert.ok(Date.parse(committedAcceptanceState.trades[0].veto_window_expires_at) > Date.now())
        assert.deepEqual(parse(await root.query(stateSql(f))), before)
      }
      await b.query(control === 'accept-commits' ? 'COMMIT;' : 'ROLLBACK;')
      const ended = await pendingA
      if ('error' in ended) throw ended.error
      const resultA = parse(ended.output)
      assert.equal(resultA.role, 'service_role')
      assert(!['40P01', '55P03', '57014'].includes(resultA.sqlstate), 'No deadlock, timeout, or cancellation is allowed')

      if (control === 'accept-commits') {
        pendingDenial(resultA, f)
        await a.query('COMMIT;')
        const after = parse(await root.query(stateSql(f)))
        assert.deepEqual(after, committedAcceptanceState, 'Stale action contributes no trade, receipt, destination, roster, balance, or notification effects')
        assert.deepEqual(after.items, before.items); assert.deepEqual(after.rosters, before.rosters)
        assert.deepEqual(after.balances, before.balances); assert.equal(after.receipts.length, 0)
        assert.equal(after.trades.length, 1); assert.equal(after.trades[0].status, 'accepted')
        assert.equal(after.trades[0].replaced_by_trade_id, null)
        print('actual-pending-to-accepted-recheck', { action, acceptance, resultA, noStaleSideEffects: true, after })
      } else {
        assert.equal(resultA.ok, true)
        // Inspect actual pending-action effects in A before deciding commit or rollback.
        const uncommitted = parse(await a.query(`RESET ROLE; ${stateSql(f)}`))
        positiveState(uncommitted, before, resultA, f)
        assert.deepEqual(parse(await root.query(stateSql(f))), before)
        await a.query(control === 'pending-action-rolls-back' ? 'ROLLBACK;' : 'COMMIT;')
        const after = parse(await root.query(stateSql(f)))
        if (control === 'pending-action-rolls-back') assert.deepEqual(after, before, 'A rollback removes every actual pending-action effect')
        else { positiveState(after, before, resultA, f); assert.deepEqual(after, uncommitted) }
        print('actual-normal-pending-positive-control', { action, control, acceptance, resultA,
          visibleUncommittedAction: true, after })
      }
    } finally {
      if (!b.ended && !b.pending) await b.query('ROLLBACK;').catch(() => {})
      if (pendingA) await pendingA
      await a.close(); await b.close()
    }
  }
  print('coverage', { actions, controls: ['accept-commits', 'accept-rolls-back', 'pending-action-rolls-back'],
    execution: 'Actual SQL transactions with observed advisory waits' })
} finally {
  const errors = []
  const clean = async (work) => { try { await work() } catch (error) { errors.push(error.message) } }
  for (const session of sessions) await clean(() => session.close())
  const cleaner = root.ended ? new Session('cleanup') : root
  for (const f of fixtures.filter((fixture) => fixture.mayClean)) await clean(async () => {
    const ids = parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.trades WHERE league_id=${quote(f.league)};`))
    await cleaner.query(`BEGIN;
      DELETE FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)}) AND request_id=${quote(f.request)};
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)})
        ${ids.length ? `OR data->>'tradeId' IN (${list(ids)})` : ''};
      DELETE FROM public.league_activity WHERE league_id=${quote(f.league)};
      DELETE FROM public.roster_transactions WHERE league_id=${quote(f.league)};
      ${ids.length ? `DELETE FROM public.trades WHERE id IN (${list(ids)});` : ''}
      DELETE FROM public.leagues WHERE id=${quote(f.league)};
      DELETE FROM public.players WHERE id IN (${list(f.players)});
      DELETE FROM auth.users WHERE id IN (${list(f.users)});
      COMMIT;
      DELETE FROM private.score_input_revisions WHERE scope IN
        (${list([`league:${f.league}`, `season:${f.season}`, ...f.players.map((id) => `player:${id}`)])});`)
    const remaining = parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)})),
      'league',(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)}),
      'season',(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)}),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)})),
      'players',(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)})),
      'rosters',(SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)})),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id=${quote(f.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
      'receipts',(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN
        (${list([`league:${f.league}`, `season:${f.season}`, ...f.players.map((id) => `player:${id}`)])})));`))
    assert(Object.values(remaining).every((count) => count === 0), `Own cleanup leaves rows: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup', { action: f.action, control: f.control, remaining })
  })
  await clean(() => cleaner.close()); if (cleaner !== root) await clean(() => root.close())
  print('cleanup-errors', { errors }); if (errors.length) throw new Error(`Own cleanup fails: ${errors.join('; ')}`)
}
