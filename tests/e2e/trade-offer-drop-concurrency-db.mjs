// Actual offer/drop lock overlap and rollback controls against an isolated local database.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const db = process.env.SUPABASE_DB_URL
assert(db, 'Owner must inject SUPABASE_DB_URL')
assert(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const expected = 'repaired'
assert(['baseline', 'repaired'].includes(expected))
const allActions = ['edit', 'edit-multi', 'counter', 'counter-multi', 'propose', 'propose-multi']
const selection = process.argv.find((arg) => arg.startsWith('--actions='))?.slice('--actions='.length)
const actions = selection ? selection.split(',') : allActions
assert(actions.length && actions.every((action) => allActions.includes(action)))
assert.equal(new Set(actions).size, actions.length)
const prefix = `owned-trade-drop-${randomUUID()}`
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`
const parse = (value) => JSON.parse(value)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions = [], fixtures = []

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
        const line = this.buffer.slice(0, at).replace(/\r$/, '')
        this.buffer = this.buffer.slice(at + 1)
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
          this.pending.reject(error ?? new Error(`Own SQL connection closed (${code}): ${this.stderr}`))
          this.pending = null
        }
        resolve(code)
      }
      this.child.on('error', (error) => end(-1, error))
      this.child.on('close', (code) => end(code))
    })
  }
  query(statement) {
    assert.equal(this.pending, null)
    assert.equal(this.ended, false)
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM'); reject(new Error('Own SQL query exceeds 25 seconds'))
      }, 25000)
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
const print = (stage, evidence) => console.log(JSON.stringify({ stage, ...evidence }))

// Temporary SECURITY INVOKER helpers capture errors from the actual public RPCs.
// They change no persistent function, trigger, or response.
const helperSql = `CREATE FUNCTION pg_temp.capture_offer(p_user uuid,p_key uuid,p_member uuid,p_action text,p_payload jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  DECLARE v_id uuid;
  BEGIN
    v_id:=public.submit_trade_offer_atomic(p_user,p_key,p_member,p_action,p_payload);
    RETURN jsonb_build_object('ok',true,'result',v_id,'role',current_user);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  END $capture$;
  CREATE FUNCTION pg_temp.capture_drop(p_roster uuid,p_season uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  BEGIN
    PERFORM public.drop_player_atomic(p_roster,p_season,NULL::uuid);
    RETURN jsonb_build_object('ok',true,'role',current_user,'subject',auth.uid());
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user,'subject',auth.uid());
  END $capture$;
  GRANT EXECUTE ON FUNCTION pg_temp.capture_offer(uuid,uuid,uuid,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION pg_temp.capture_drop(uuid,uuid) TO authenticated;
  DO $grant$ BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role,authenticated',
      (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
  END $grant$;`

async function waitAOnB(aPid, bPid, settled) {
  const deadline = Date.now() + 7000
  let evidence
  while (Date.now() < deadline) {
    evidence = parse(await root.query(`SELECT jsonb_build_object(
      'aPid',${aPid},'bPid',${bPid},'aState',a.state,'bState',b.state,
      'waitType',a.wait_event_type,'waitEvent',a.wait_event,
      'blockingPids',pg_blocking_pids(a.pid),'waitsOnB',${bPid}=ANY(pg_blocking_pids(a.pid)))
      FROM pg_stat_activity a JOIN pg_stat_activity b ON b.pid=${bPid} WHERE a.pid=${aPid};`))
    if (evidence.waitType === 'Lock' && evidence.waitsOnB) {
      assert.equal(settled(), false)
      assert.equal(evidence.aState, 'active')
      assert.equal(evidence.bState, 'idle in transaction')
      return evidence
    }
    if (settled()) return { ...evidence, refused: true }
    await sleep(25)
  }
  throw new Error(`No observed own A-on-B lock wait: ${JSON.stringify(evidence)}`)
}

async function fixture(action, outcome) {
  const f = { action, outcome, league: randomUUID(), season: randomUUID(),
    users: Array.from({ length: 3 }, () => randomUUID()), members: Array.from({ length: 3 }, () => randomUUID()),
    players: [randomUUID(), randomUUID()], rosters: [randomUUID(), randomUUID()],
    request: randomUUID(), trades: new Set(), mayClean: false, owns: false, source: null }
  fixtures.push(f)
  const ownScopes = [`league:${f.league}`, `season:${f.season}`, ...f.players.map((id) => `player:${id}`)]
  assert.equal(await root.query(`SELECT
    (SELECT count(*) FROM auth.users WHERE id IN (${list(f.users)}))
    +(SELECT count(*) FROM public.leagues WHERE id=${quote(f.league)})
    +(SELECT count(*) FROM public.league_seasons WHERE id=${quote(f.season)})
    +(SELECT count(*) FROM public.league_members WHERE id IN (${list(f.members)}))
    +(SELECT count(*) FROM public.players WHERE id IN (${list(f.players)}))
    +(SELECT count(*) FROM public.roster_players WHERE id IN (${list(f.rosters)}))
    +(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)}))
    +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${list(ownScopes)}));`), '0')
  f.mayClean = true; f.owns = true
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(f.users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode,trade_deadline)
      VALUES(${quote(f.league)},'Owned trade drop race',${quote(f.league)},${quote(f.users[0])},'active','faab',NULL);
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      (${quote(f.members[0])},${quote(f.league)},${quote(f.users[0])},'commissioner','A'),
      (${quote(f.members[1])},${quote(f.league)},${quote(f.users[1])},'manager','B'),
      (${quote(f.members[2])},${quote(f.league)},${quote(f.users[2])},'manager','C');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(f.season)},${quote(f.league)},2162,true);
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT ${quote(f.league)},${quote(f.season)},id,100 FROM unnest(ARRAY[${list(f.members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp) VALUES
      (${quote(f.players[0])},'Synthetic',${quote(`Drop${f.league}`)},'PG',ARRAY['PG'],NULL,2),
      (${quote(f.players[1])},'Synthetic',${quote(`Keep${f.league}`)},'PG',ARRAY['PG'],NULL,2);
    INSERT INTO public.roster_players(id,player_id,member_id,league_id,league_season_id,acquired_via,is_on_ir,is_on_taxi) VALUES
      (${quote(f.rosters[0])},${quote(f.players[0])},${quote(f.members[0])},${quote(f.league)},${quote(f.season)},'draft',false,false),
      (${quote(f.rosters[1])},${quote(f.players[1])},${quote(f.members[1])},${quote(f.league)},${quote(f.season)},'draft',false,false);
    COMMIT;`)
  f.expiresAt = new Date(Date.now() + 86400000).toISOString()
  f.multi = action.endsWith('-multi'); f.counter = action.startsWith('counter'); f.propose = action.startsWith('propose')
  f.actor = f.counter ? 1 : 0
  f.items = [{ fromMemberId: f.members[0], toMemberId: f.members[1], playerId: f.players[0] },
    { fromMemberId: f.members[2], toMemberId: f.members[0], faabAmount: 1 }]
  if (!f.propose) {
    const sourceCall = f.multi
      ? `public.propose_multi_team_trade_atomic(${quote(f.league)},${quote(f.season)},${quote(f.members[0])},ARRAY[${list(f.members)}]::uuid[],${json(f.items)},'Owned source',${quote(f.expiresAt)}::timestamptz)`
      : `public.propose_trade_atomic(${quote(f.league)},${quote(f.season)},${quote(f.members[0])},${quote(f.members[1])},ARRAY[${quote(f.players[0])}]::uuid[],ARRAY[${quote(f.players[1])}]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'Owned source',${quote(f.expiresAt)}::timestamptz,0,0)`
    f.source = await root.query(`BEGIN; SET LOCAL ROLE service_role; SELECT ${sourceCall}; COMMIT;`)
    assert.match(f.source, /^[0-9a-f-]{36}$/); f.trades.add(f.source)
  }
  f.payload = { notes: `Owned ${action} ${outcome}`, expiresAt: f.expiresAt,
    ...(f.multi ? { participantMemberIds: f.members, items: f.items } : {
      offerPlayerIds: [f.players[f.counter ? 1 : 0]], requestPlayerIds: [f.players[f.counter ? 0 : 1]],
      offerPickIds: [], requestPickIds: [], offerFaabAmount: 0, requestFaabAmount: 0 }),
    ...(f.source ? { tradeId: f.source } : { leagueId: f.league, leagueSeasonId: f.season,
      ...(!f.multi ? { recipientMemberId: f.members[1] } : {}) }) }
  return f
}

const stateSql = (f) => `SELECT jsonb_build_object(
  'rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.roster_players r WHERE r.league_id=${quote(f.league)}),
  'trades',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM public.trades t WHERE t.league_id=${quote(f.league)}),
  'items',(SELECT count(*) FROM public.trade_items WHERE trade_id IN (SELECT id FROM public.trades WHERE league_id=${quote(f.league)})),
  'receipts',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]') FROM private.trade_offer_requests r WHERE user_id IN (${list(f.users)})),
  'waivers',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${quote(f.league)} AND player_id=${quote(f.players[0])}),
  'drops',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)} AND player_id=${quote(f.players[0])} AND transaction_type='fa_drop'));`

try {
  for (const action of actions) for (const outcome of ['drop-commits', 'drop-prefix-rolls-back']) {
    const f = await fixture(action, outcome)
    const a = open(`${action}-${outcome}-offer`), b = open(`${action}-${outcome}-drop`)
    await a.query(helperSql); await b.query(helperSql)
    const aPid = Number(await a.query('SELECT pg_backend_pid();')), bPid = Number(await b.query('SELECT pg_backend_pid();'))
    let aSettled = false, pendingA
    const before = parse(await root.query(stateSql(f)))
    try {
      // These are the exact prefix locks acquired by the real drop function.
      // Replacement schedule includes league. Constructor schedule stops before league.
      await b.query(`BEGIN ISOLATION LEVEL READ COMMITTED;
        DO $lock$ BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(${quote(f.league)}),hashtext(${quote(f.members[0])}));
          PERFORM pg_advisory_xact_lock(hashtext(${quote(f.league)}),hashtext(${quote(f.players[0])}));
          PERFORM 1 FROM public.roster_players WHERE id=${quote(f.rosters[0])} FOR UPDATE;
          ${f.propose ? '' : `PERFORM 1 FROM public.leagues WHERE id=${quote(f.league)} FOR UPDATE;`}
        END $lock$;`)
      pendingA = a.query(`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role;
        SELECT pg_temp.capture_offer(${quote(f.users[f.actor])}::uuid,${quote(f.request)}::uuid,
          ${quote(f.members[f.actor])}::uuid,${quote(action)},${json(f.payload)}); COMMIT;`)
        .then((output) => { aSettled = true; return { output } }, (error) => { aSettled = true; return { error } })
      const waiting = await waitAOnB(aPid, bPid, () => aSettled)
      assert.deepEqual(parse(await root.query(stateSql(f))), before, 'Prefix locks alone must change no committed rows')
      print('actual-offer-waits-on-drop-prefix', { action, outcome,
        schedule: f.propose ? 'constructor-league-to-roster' : 'replacement-source-to-league', waiting })
      let resultB = null
      if (outcome === 'drop-prefix-rolls-back') await b.query('ROLLBACK;')
      else resultB = parse(await b.query(`SET LOCAL ROLE authenticated;
        DO $jwt$ BEGIN
          PERFORM set_config('request.jwt.claim.sub',${quote(f.users[0])},true);
          PERFORM set_config('request.jwt.claims',${quote(JSON.stringify({ sub: f.users[0], role: 'authenticated' }))},true);
        END $jwt$;
        SELECT pg_temp.capture_drop(${quote(f.rosters[0])}::uuid,${quote(f.season)}::uuid); COMMIT;`))
      let endedA = await pendingA
      if ('error' in endedA) throw endedA.error
      if (waiting.refused) {
        const refused = parse(endedA.output)
        assert.equal(refused.ok, false)
        assert.match(refused.message, /busy|Try.*again/i)
        endedA = { output: await a.query(`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role;
          SELECT pg_temp.capture_offer(${quote(f.users[f.actor])}::uuid,${quote(f.request)}::uuid,
            ${quote(f.members[f.actor])}::uuid,${quote(action)},${json(f.payload)}); COMMIT;`) }
      }
      const resultA = parse(endedA.output)
      assert.equal(resultA.role, 'service_role')
      if (resultA.ok && resultA.result) f.trades.add(resultA.result)
      if (resultB) { assert.equal(resultB.role, 'authenticated'); assert.equal(resultB.subject, f.users[0]) }
      const results = [resultA, resultB].filter(Boolean)
      assert(results.every((result) => !['55P03', '57014'].includes(result.sqlstate)), 'Timeout is not deadlock evidence')
      const deadlocks = results.filter((result) => result.sqlstate === '40P01')
      const after = parse(await root.query(stateSql(f)))
      if (outcome === 'drop-prefix-rolls-back' || !f.propose) {
        if (resultB) { assert.equal(resultB.ok, false); assert.match(resultB.message, /Locked by trade/) }
        assert.equal(deadlocks.length, 0); assert.equal(resultA.ok, true); assert.match(resultA.result, /^[0-9a-f-]{36}$/)
        assert.deepEqual(after.rosters, before.rosters); assert.equal(after.waivers, 0); assert.equal(after.drops, 0)
        assert.equal(after.trades.length, before.trades.length + 1)
        assert.equal(after.receipts.length, 1); assert.equal(after.receipts[0].completed, true)
        assert.equal(after.receipts[0].result_trade_id, resultA.result)
        if (f.source) {
          const source = after.trades.find((trade) => trade.id === f.source)
          assert.equal(source.status, f.counter ? 'countered' : 'edited')
          assert.equal(source.replaced_by_trade_id, resultA.result)
        }
      } else {
        assert.equal(deadlocks.length, 0); assert.equal(resultB.ok, true)
        assert.equal(resultA.ok, false); assert.ok(resultA.sqlstate)
        assert.match(resultA.message, f.propose ? /no longer owned/ : /Only pending offers|no longer pending/)
        assert.equal(after.rosters.some((roster) => roster.id === f.rosters[0]), false)
        assert.equal(after.rosters.some((roster) => roster.id === f.rosters[1]), true)
        assert.equal(after.waivers, 1); assert.equal(after.drops, 1); assert.equal(after.receipts.length, 0)
        assert.equal(after.trades.length, before.trades.length)
        if (f.source) {
          const source = after.trades.find((trade) => trade.id === f.source)
          assert.equal(source.status, 'expired'); assert.equal(source.replaced_by_trade_id, null)
          assert.match(source.completion_failure_reason, /no longer on/)
        }
      }
      // Committed rows must match the authenticated drop result.
      if (resultB?.ok) {
        assert.equal(after.rosters.some((roster) => roster.id === f.rosters[0]), false)
        assert.equal(after.waivers, 1); assert.equal(after.drops, 1)
        if (f.source) assert.equal(after.trades.find((trade) => trade.id === f.source).status, 'expired')
      }
      if (resultB && !resultB.ok) { assert.deepEqual(after.rosters, before.rosters); assert.equal(after.waivers, 0); assert.equal(after.drops, 0) }
      print('actual-overlap-result', { action, outcome, expected, resultA, resultB, realDeadlocks: deadlocks.length, after })
    } finally {
      // Free B first so an outstanding A can finish before fixture cleanup.
      if (!b.ended && !b.pending) await b.query('ROLLBACK;').catch(() => {})
      if (pendingA) await pendingA
      await a.close(); await b.close()
    }
  }
  print('coverage', { actions, outcomes: ['drop-commits', 'drop-prefix-rolls-back'],
    execution: 'Actual public SQL operations and authenticated roster drops' })
} finally {
  const errors = []
  const clean = async (work) => { try { await work() } catch (error) { errors.push(error.message) } }
  for (const session of sessions) await clean(() => session.close())
  const cleaner = root.ended ? new Session('cleanup') : root
  for (const f of fixtures.filter((fixture) => fixture.mayClean)) await clean(async () => {
    const ids = parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]') FROM public.trades WHERE league_id=${quote(f.league)};`))
    ids.forEach((id) => f.trades.add(id))
    await cleaner.query(`BEGIN;
      DELETE FROM private.trade_offer_requests WHERE user_id=${quote(f.users[f.actor ?? 0])} AND request_id=${quote(f.request)};
      DELETE FROM public.notification_outbox WHERE member_id IN (${list(f.members)})
        ${f.trades.size ? `OR data->>'tradeId' IN (${list([...f.trades])})` : ''};
      DELETE FROM public.league_activity WHERE league_id=${quote(f.league)};
      ${f.trades.size ? `DELETE FROM public.trades WHERE id IN (${list([...f.trades])});` : ''}
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
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id=${quote(f.league)}),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(f.members)})),
      'waivers',(SELECT count(*) FROM public.waiver_wire_log WHERE league_id=${quote(f.league)}),
      'transactions',(SELECT count(*) FROM public.roster_transactions WHERE league_id=${quote(f.league)}),
      'receipts',(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(f.users)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN
        (${list([`league:${f.league}`, `season:${f.season}`, ...f.players.map((id) => `player:${id}`)])})));`))
    assert(Object.values(remaining).every((count) => count === 0), `Own cleanup leaves rows: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup', { action: f.action, outcome: f.outcome, remaining })
  })
  await clean(() => cleaner.close())
  if (cleaner !== root) await clean(() => root.close())
  print('cleanup-errors', { errors })
  if (errors.length) throw new Error(`Own cleanup fails: ${errors.join('; ')}`)
}
