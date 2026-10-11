import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

// Exercise real transactions against an isolated local database.
const db = process.env.SUPABASE_DB_URL
assert(db, 'Owner must inject SUPABASE_DB_URL')
assert(['127.0.0.1', 'localhost'].includes(new URL(db).hostname), 'Use an isolated local database')
const allActions = ['propose', 'propose-multi', 'edit', 'edit-multi', 'counter', 'counter-multi']
const selected = process.argv.find((arg) => arg.startsWith('--actions='))?.slice('--actions='.length)
const actions = selected ? selected.split(',') : allActions
assert(actions.length && actions.every((action) => allActions.includes(action)))
assert.equal(new Set(actions).size, actions.length)
const token = randomUUID().replaceAll('-', '')
const prefix = `trade-receipt-${token}`
const users = Array.from({ length: 3 }, () => randomUUID())
const members = Array.from({ length: 3 }, () => randomUUID())
const league = randomUUID(), season = randomUUID()
const ownedPairs = [], observedTradeIds = new Set(), sessions = []
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const list = (values) => values.map(quote).join(',')
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let ownsFixture = false, mayCleanRevisions = false

class Session {
  constructor(name) {
    this.name = name
    this.pending = null
    this.buffer = ''
    this.lines = []
    this.stderr = ''
    this.ended = false
    this.closePromise = null
    this.child = spawn('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
      env: { ...process.env, PGAPPNAME: name,
        PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=18000 -c idle_in_transaction_session_timeout=60000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let at
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, '')
        this.buffer = this.buffer.slice(at + 1)
        if (this.pending && line === this.pending.marker) {
          const pending = this.pending
          this.pending = null
          clearTimeout(pending.timer)
          const output = this.lines.join('\n').trim()
          this.lines = []
          pending.resolve(output)
        } else this.lines.push(line)
      }
    })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk })
    this.closed = new Promise((resolve) => {
      this.child.on('error', (error) => {
        this.ended = true
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
        resolve(-1)
      })
      this.child.on('close', (code) => {
        this.ended = true
        if (this.pending) {
          clearTimeout(this.pending.timer)
          this.pending.reject(new Error(`Own SQL session closed (${code}): ${this.stderr}`))
          this.pending = null
        }
        resolve(code)
      })
    })
  }
  query(statement) {
    assert.equal(this.pending, null, 'One query per own SQL connection')
    assert.equal(this.ended, false, 'Own SQL connection must be open')
    return new Promise((resolve, reject) => {
      const marker = `DONE_${randomUUID()}`
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM')
        reject(new Error('Own SQL query exceeded 30 seconds'))
      }, 30000)
      this.pending = { marker, resolve, reject, timer }
      this.child.stdin.write(`${statement}\nSELECT ${quote(marker)};\n`)
    })
  }
  close() {
    if (!this.closePromise) this.closePromise = (async () => {
      // Kill only this owned connection if a pending query cannot accept ROLLBACK.
      if (this.pending) this.child.kill('SIGTERM')
      else if (!this.ended) await this.query('ROLLBACK;').catch(() => {})
      this.child.stdin.end()
      await this.closed
    })()
    return this.closePromise
  }
}
const root = new Session(`${prefix}-inspector`)
const open = (name) => { const session = new Session(`${prefix}-${name}`); sessions.push(session); return session }
const parse = (output) => JSON.parse(output)

// This temporary helper catches real PostgreSQL errors and returns their SQLSTATE.
// It is SECURITY INVOKER. Each tested RPC executes as the explicitly selected role.
const helperSql = `CREATE FUNCTION pg_temp.capture_offer(p_user uuid,p_key uuid,p_member uuid,p_action text,p_payload jsonb)
  RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $capture$
  DECLARE v_result uuid;
  BEGIN
    v_result := public.submit_trade_offer_atomic(p_user,p_key,p_member,p_action,p_payload);
    RETURN jsonb_build_object('ok',true,'result',v_result,'role',current_user);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok',false,'sqlstate',SQLSTATE,'message',SQLERRM,'role',current_user);
  END;
  $capture$;
  GRANT EXECUTE ON FUNCTION pg_temp.capture_offer(uuid,uuid,uuid,text,jsonb) TO service_role,anon,authenticated;
  DO $grant$ BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role,anon,authenticated',
      (SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()));
  END $grant$;`
const invocation = (user, key, member, action, payload) =>
  `SELECT pg_temp.capture_offer(${quote(user)}::uuid,${quote(key)}::uuid,${quote(member)}::uuid,${quote(action)},${json(payload)});`
const countStateSql = () => `SELECT jsonb_build_object(
  'trades',(SELECT count(*) FROM public.trades WHERE league_id='${league}'),
  'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(members)})),
  'activity',(SELECT count(*) FROM public.league_activity WHERE league_id='${league}'),
  'receipts',(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(users)})))`
const state = async () => parse(await root.query(`${countStateSql()};`))
const expiresAt = new Date(Date.now() + 86400000).toISOString()
const terms = { offerPlayerIds: [], requestPlayerIds: [], offerPickIds: [], requestPickIds: [],
  offerFaabAmount: 1, requestFaabAmount: 1, notes: 'Owned receipt concurrency', expiresAt }
const multiTerms = { participantMemberIds: members,
  items: [{ fromMemberId: members[0], toMemberId: members[1], faabAmount: 1 },
    { fromMemberId: members[0], toMemberId: members[2], faabAmount: 1 }],
  notes: 'Owned multi receipt concurrency', expiresAt }
const print = (stage, evidence) => console.log(JSON.stringify({ stage, ...evidence }))

async function seedSource(multi) {
  const call = multi
    ? `public.propose_multi_team_trade_atomic('${league}','${season}','${members[0]}',ARRAY[${list(members)}]::uuid[],${json(multiTerms.items)},'Owned source',${quote(expiresAt)}::timestamptz)`
    : `public.propose_trade_atomic('${league}','${season}','${members[0]}','${members[1]}',ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[],'Owned source',${quote(expiresAt)}::timestamptz,1,1)`
  const id = await root.query(`BEGIN; SET LOCAL ROLE service_role; SELECT ${call}; COMMIT;`)
  assert.match(id, /^[0-9a-f-]{36}$/)
  observedTradeIds.add(id)
  return id
}

async function waitForB(aPid, bPid, settled) {
  const deadline = Date.now() + 8000
  let value
  while (Date.now() < deadline) {
    value = parse(await root.query(`SELECT jsonb_build_object(
      'aPid',${aPid},'bPid',${bPid},'aState',a.state,'bState',b.state,
      'waitType',b.wait_event_type,'waitEvent',b.wait_event,
      'blockingPids',pg_blocking_pids(b.pid),
      'waitsOnA',${aPid}=ANY(pg_blocking_pids(b.pid)),
      'sameTransactionLock',EXISTS(SELECT 1 FROM pg_locks waiting JOIN pg_locks holding
        ON waiting.locktype=holding.locktype AND waiting.transactionid=holding.transactionid
        WHERE waiting.pid=${bPid} AND holding.pid=${aPid}
          AND waiting.locktype='transactionid' AND NOT waiting.granted AND holding.granted))
      FROM pg_stat_activity a JOIN pg_stat_activity b ON b.pid=${bPid} WHERE a.pid=${aPid};`))
    if (value.waitType === 'Lock' && value.waitEvent === 'transactionid' && value.waitsOnA && value.sameTransactionLock) {
      assert.equal(settled(), false, 'B must remain pending before A ends')
      assert.equal(value.aState, 'idle in transaction')
      assert.equal(value.bState, 'active')
      return value
    }
    assert.equal(settled(), false, 'B returned before the controlled wait')
    await sleep(25)
  }
  throw new Error(`No actual B-on-A transaction wait: ${JSON.stringify(value)}`)
}

try {
  // All fixtures commit before either concurrent action begins.
  assert.equal(await root.query(`SELECT (SELECT count(*) FROM public.leagues WHERE id='${league}')
    +(SELECT count(*) FROM public.league_seasons WHERE id='${season}')
    +(SELECT count(*) FROM public.league_members WHERE id IN (${list(members)}))
    +(SELECT count(*) FROM auth.users WHERE id IN (${list(users)}))
    +(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(users)}))
    +(SELECT count(*) FROM private.score_input_revisions WHERE scope IN ('league:${league}','season:${season}'));`), '0')
  mayCleanRevisions = true
  ownsFixture = true
  print('owned-fixture-identifiers', { league, season, users, members })
  await root.query(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
      FROM unnest(ARRAY[${list(users)}]::uuid[]) id;
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,waiver_mode)
      VALUES('${league}','Owned trade receipt concurrency','${league}','${users[0]}','active','faab');
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES
      ('${members[0]}','${league}','${users[0]}','commissioner','A'),
      ('${members[1]}','${league}','${users[1]}','manager','B'),
      ('${members[2]}','${league}','${users[2]}','manager','C');
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',2162,true);
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT '${league}','${season}',id,100 FROM unnest(ARRAY[${list(members)}]::uuid[]) id
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET balance=100;
    COMMIT;`)
  const committedFixture = parse(await root.query(`SELECT jsonb_build_object(
    'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(users)})),
    'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(members)})),
    'season',(SELECT count(*) FROM public.league_seasons WHERE id='${season}'));`))
  assert.deepEqual(committedFixture, { users: 3, members: 3, season: 1 })
  print('committed-own-fixture', committedFixture)

  // Real permission denial controls use the same function and actual SQL roles.
  const permission = open('permission')
  await permission.query(helperSql)
  for (const role of ['anon', 'authenticated']) {
    const key = randomUUID()
    ownedPairs.push([users[0], key])
    const before = await state()
    const result = parse(await permission.query(`BEGIN; SET LOCAL ROLE ${role};
      ${invocation(users[0], key, members[0], 'propose', { ...terms, leagueId: league, leagueSeasonId: season, recipientMemberId: members[1] })}
      ROLLBACK;`))
    assert.equal(result.ok, false)
    assert.equal(result.role, role)
    assert.equal(result.sqlstate, '42501')
    assert.match(result.message, /permission denied.*submit_trade_offer_atomic/)
    assert.deepEqual(await state(), before)
    print('actual-role-denied', { role, result, noRowsChanged: true })
  }

  for (const action of actions) for (const control of ['same-terms-commit', 'changed-terms-commit', 'first-rolls-back']) {
    const multi = action.endsWith('-multi'), counter = action.startsWith('counter')
    const actor = counter ? 1 : 0
    const key = randomUUID()
    ownedPairs.push([users[actor], key])
    const source = action.startsWith('propose') ? null : await seedSource(multi)
    const payload = { ...(multi ? multiTerms : terms), notes: `Owned ${action} ${control}`,
      ...(source ? { tradeId: source } : { leagueId: league, leagueSeasonId: season,
        ...(!multi ? { recipientMemberId: members[1] } : {}) }) }
    const bPayload = control === 'changed-terms-commit' ? { ...payload, notes: `${payload.notes} changed` } : payload
    const before = await state()
    const a = open(`${action}-${control}-a`), b = open(`${action}-${control}-b`)
    await a.query(helperSql)
    await b.query(helperSql)
    const aPid = Number(await a.query('SELECT pg_backend_pid();'))
    const bPid = Number(await b.query('SELECT pg_backend_pid();'))
    assert(Number.isInteger(aPid) && Number.isInteger(bPid) && aPid !== bPid)
    let bSettled = false, pendingB
    try {
      const resultA = parse(await a.query(`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role;
        ${invocation(users[actor], key, members[actor], action, payload)}`))
      assert.equal(resultA.ok, true)
      assert.equal(resultA.role, 'service_role')
      assert.match(resultA.result, /^[0-9a-f-]{36}$/)
      observedTradeIds.add(resultA.result)
      // Deliberately leave A open after its real completed receipt and offer writes.
      pendingB = b.query(`BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL ROLE service_role;
        ${invocation(users[actor], key, members[actor], action, bPayload)} COMMIT;`)
        .then((output) => { bSettled = true; return { output } }, (error) => { bSettled = true; return { error } })
      const waiting = await waitForB(aPid, bPid, () => bSettled)
      assert.deepEqual(await state(), before, 'Inspector must not see A uncommitted effects')
      print('actual-B-waits-on-A', { action, control, waiting, committedCountsUnchanged: true })
      await a.query(control === 'first-rolls-back' ? 'ROLLBACK;' : 'COMMIT;')
      const finished = await pendingB
      if ('error' in finished) throw finished.error
      const resultB = parse(finished.output)
      assert.equal(resultB.role, 'service_role')
      if (control === 'changed-terms-commit') {
        assert.equal(resultB.ok, false)
        assert.equal(resultB.sqlstate, '22023')
        assert.match(resultB.message, /request key.*different trade terms/)
      } else {
        assert.equal(resultB.ok, true)
        assert.match(resultB.result, /^[0-9a-f-]{36}$/)
        if (control === 'first-rolls-back') assert.notEqual(resultB.result, resultA.result)
        else assert.equal(resultB.result, resultA.result)
        observedTradeIds.add(resultB.result)
      }
      const committedId = control === 'first-rolls-back' ? resultB.result : resultA.result
      const after = await state()
      assert.deepEqual(after, { trades: before.trades + 1, outbox: before.outbox + (multi ? 2 : 1),
        activity: before.activity + 1, receipts: before.receipts + 1 })
      const actual = parse(await root.query(`SELECT jsonb_build_object(
        'trade',(SELECT to_jsonb(t) FROM public.trades t WHERE id='${committedId}'),
        'receipt',(SELECT to_jsonb(r) FROM private.trade_offer_requests r WHERE user_id='${users[actor]}' AND request_id='${key}'),
        'outbox',(SELECT count(*) FROM public.notification_outbox WHERE data @> jsonb_build_object('tradeId','${committedId}'::uuid)),
        'activity',(SELECT count(*) FROM public.league_activity WHERE related_trade_id='${committedId}'),
        'items',(SELECT count(*) FROM public.trade_items WHERE trade_id='${committedId}'),
        'participants',(SELECT count(*) FROM public.trade_participants WHERE trade_id='${committedId}'),
        'source',${source ? `(SELECT to_jsonb(t) FROM public.trades t WHERE id='${source}')` : "'null'::jsonb"},
        'rolledBackOfferAbsent',${control === 'first-rolls-back' ? `NOT EXISTS(SELECT 1 FROM public.trades WHERE id='${resultA.result}')` : 'true'});`))
      assert.equal(actual.receipt.completed, true)
      assert.equal(actual.receipt.result_trade_id, committedId)
      assert.equal(actual.receipt.member_id, members[actor])
      assert.equal(actual.receipt.request_payload.action, action)
      assert.equal(actual.receipt.request_payload.notes, payload.notes)
      assert.equal(actual.trade.notes, payload.notes)
      assert.equal(actual.outbox, multi ? 2 : 1)
      assert.equal(actual.activity, 1)
      assert.equal(actual.items, 2)
      assert.equal(actual.participants, multi ? 3 : 2)
      assert.equal(actual.rolledBackOfferAbsent, true)
      if (source) {
        assert.equal(actual.source.replaced_by_trade_id, committedId)
        assert.equal(actual.source.status, counter ? 'countered' : 'edited')
        assert.equal(actual.trade.version, actual.source.version + 1)
        assert.equal(actual.trade[counter ? 'countered_from_trade_id' : 'edited_from_trade_id'], source)
      }
      print('actual-concurrent-result', { action, control, resultA, resultB, before, after, actual })
    } finally {
      // Ending A first frees B. Both own connections close before cleanup.
      if (!a.ended && !a.pending) await a.query('ROLLBACK;').catch(() => {})
      if (pendingB) await pendingB
      await a.close()
      await b.close()
    }
  }
  // A successful receipt replays after real expiration. An uncommitted expired request does not persist.
  await root.query(helperSql)
  for (const action of ['propose', 'propose-multi']) {
    const multi = action.endsWith('-multi'), key = randomUUID(), failedKey = randomUUID()
    ownedPairs.push([users[0], key], [users[0], failedKey])
    const expiresAt = parse(await root.query("SELECT to_jsonb(clock_timestamp()+interval '2 seconds');"))
    const payload = { ...(multi ? multiTerms : terms), leagueId: league, leagueSeasonId: season,
      ...(multi ? {} : { recipientMemberId: members[1] }), expiresAt }
    const call = (requestKey, value) => root.query(`BEGIN; SET LOCAL ROLE service_role;
      ${invocation(users[0], requestKey, members[0], action, value)} COMMIT;`).then(parse)
    const first = await call(key, payload)
    assert.equal(first.ok, true)
    observedTradeIds.add(first.result)
    const committed = await state()
    await sleep(Math.max(0, Date.parse(expiresAt) - Date.now()) + 150)
    assert.equal(await root.query(`SELECT clock_timestamp() > ${quote(expiresAt)}::timestamptz;`), 't')
    const replay = await call(key, payload)
    assert.equal(replay.ok, true)
    assert.equal(replay.result, first.result)
    assert.deepEqual(await state(), committed)
    const rejected = await call(failedKey, payload)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.sqlstate, '22023')
    assert.equal(rejected.message, 'Trade expiration must be in the future.')
    assert.deepEqual(await state(), committed)
    assert.equal(await root.query(`SELECT count(*) FROM private.trade_offer_requests WHERE user_id='${users[0]}' AND request_id='${failedKey}';`), '0')
    const recovered = await call(failedKey, { ...payload, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    assert.equal(recovered.ok, true)
    assert.notEqual(recovered.result, first.result)
    observedTradeIds.add(recovered.result)
    print('actual-expired-request-recovery', { action, successfulReplay: replay.result, expiredRejection: rejected,
      failedRequestRolledBack: true, recovered: recovered.result })
  }
  print('coverage', { actions, controls: ['same-terms-commit', 'changed-terms-commit', 'first-rolls-back'],
    cases: actions.length * 3, observedOnlyActualDatabaseResults: true })
} finally {
  const cleanupErrors = []
  const clean = async (work) => { try { await work() } catch (error) { cleanupErrors.push(error.message) } }
  for (const session of sessions) await clean(() => session.close())
  // Reconnect if a setup SQL error closed the inspector. Failed BEGIN setup rolls back itself.
  const cleaner = !root.ended ? root : new Session(`${prefix}-cleanup`)
  if (mayCleanRevisions) await clean(async () => {
    if (ownsFixture) {
      const ids = parse(await cleaner.query(`SELECT COALESCE(jsonb_agg(id),'[]'::jsonb) FROM public.trades WHERE league_id='${league}';`))
      ids.forEach((id) => observedTradeIds.add(id))
      const tradeIds = [...observedTradeIds]
      await cleaner.query(`BEGIN;
        ${ownedPairs.length ? `DELETE FROM private.trade_offer_requests WHERE (user_id,request_id) IN (${ownedPairs.map(([user, key]) => `(${quote(user)}::uuid,${quote(key)}::uuid)`).join(',')});` : ''}
        DELETE FROM public.notification_outbox WHERE member_id IN (${list(members)})
          ${tradeIds.length ? `OR data->>'tradeId' IN (${list(tradeIds)})` : ''};
        DELETE FROM public.league_activity WHERE league_id='${league}';
        ${tradeIds.length ? `DELETE FROM public.trades WHERE id IN (${list(tradeIds)});` : ''}
        DELETE FROM public.leagues WHERE id='${league}';
        DELETE FROM auth.users WHERE id IN (${list(users)});
        COMMIT;`)
    }
    // Only exact own revision scopes. Run this after all trigger-producing deletes.
    await cleaner.query(`DELETE FROM private.score_input_revisions WHERE scope IN ('league:${league}','season:${season}');`)
    const remaining = parse(await cleaner.query(`SELECT jsonb_build_object(
      'users',(SELECT count(*) FROM auth.users WHERE id IN (${list(users)})),
      'members',(SELECT count(*) FROM public.league_members WHERE id IN (${list(members)})),
      'league',(SELECT count(*) FROM public.leagues WHERE id='${league}'),
      'season',(SELECT count(*) FROM public.league_seasons WHERE id='${season}'),
      'trades',(SELECT count(*) FROM public.trades WHERE league_id='${league}'),
      'outbox',(SELECT count(*) FROM public.notification_outbox WHERE member_id IN (${list(members)})),
      'activity',(SELECT count(*) FROM public.league_activity WHERE league_id='${league}'),
      'receipts',(SELECT count(*) FROM private.trade_offer_requests WHERE user_id IN (${list(users)})),
      'revisions',(SELECT count(*) FROM private.score_input_revisions WHERE scope IN ('league:${league}','season:${season}')));`))
    assert(Object.values(remaining).every((count) => count === 0), `Owned cleanup incomplete: ${JSON.stringify(remaining)}`)
    print('actual-owned-cleanup', { remaining })
  })
  await clean(() => cleaner.close())
  if (cleaner !== root) await clean(() => root.close())
  print('cleanup-errors', { errors: cleanupErrors })
  if (cleanupErrors.length) throw new Error(`Owned cleanup failed: ${cleanupErrors.join('; ')}`)
}
