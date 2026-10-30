import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { auditSetup, fixedClock, fixture, functionCounters, labSetup, quote, sequenceReset, statementCounters, writeCounters } from './trades-actions-sql.mjs'
import { SqlSession, startTransport } from './trades-actions-transport.mjs'
import { compareActionResults as compare, nestedPlans } from './trades-actions-report.mjs'

const Deno = globalThis.Deno
const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.ok(existsSync(path.join(lane, 'ready')))
const variants = ['baseline', 'candidate']
const candidateFiles = ['supabase/sql/functions/by-name/private/check_trade_legality.sql', 'supabase/sql/functions/by-name/public/get_trade_estimate_reanalysis_inputs.sql']
const argumentsList = Deno.args
const option = (name, fallback) => argumentsList.includes(name) ? argumentsList[argumentsList.indexOf(name) + 1] : fallback
const baseline = option('--baseline', '952580ce')
assert.match(baseline, /^[a-f0-9]{8,40}$/)
const mode = option('--mode', 'parity')
const repeats = Number(option('--repeats', '5'))
const only = option('--only', '')
const traceEnabled = argumentsList.includes('--trace')
const output = option('--output', path.join(lane, 'evidence', mode))
mkdirSync(output, { recursive: true })
const RealDate = globalThis.Date
const epoch = RealDate.parse(fixedClock)
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [epoch])) } static now() { return epoch } }
let errorId = 0
crypto.randomUUID = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++errorId).padStart(12, '0')}`
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:64390')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_private_trade_harness')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'private-trade-harness')
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.equal(url.origin, 'http://127.0.0.1:64390', 'External transport is forbidden')
  return originalFetch(input, init)
}
const state = { session: null, user: null }
const server = await startTransport(state)
const { handleTradeRoute } = await import('../../supabase/functions/api/trades.ts')
const { handleApiRequest } = await import('../../supabase/functions/_shared/apiRuntime.ts')
const { handleTradeEstimateWork, handleTradeActivationWork } = await import('../../supabase/functions/api/tradeEstimateWork.ts')
const { handlePickPredictionWork } = await import('../../supabase/functions/api/pickPredictionWork.ts')
let processTrades
const originalServe = Deno.serve
Deno.serve = callback => { processTrades = callback }
try { await import('../../supabase/functions/process-trades/index.ts') } finally { Deno.serve = originalServe }

const requestId = 'cccccccc-cccc-4ccc-8ccc-000000000001'
const sourceRequest = 'cccccccc-cccc-4ccc-8ccc-000000000002'
const call = (name, args) => `public.${name}(${args.map(quote).join(',')})`
const summary = rows => Object.fromEntries(['insert', 'update', 'delete'].map(key => [key, Object.values(rows).reduce((sum, value) => sum + value[key], 0)]))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const compact = result => ({ ...result, runtimeVerified: true, rows: result.rows == null ? null : Object.fromEntries(['before', 'after'].map(phase => [phase,
  Object.fromEntries(Object.entries(result.rows[phase] ?? {}).map(([table, rows]) => [table, { sha256: digest(rows), rowCount: rows.length }]))])) })

async function snapshot(session) {
  const relations = await session.value("SELECT coalesce(jsonb_agg(relation ORDER BY relation),'[]') FROM trades_actions_touched;")
  const rows = {}
  for (const relation of relations) rows[relation] = (await session.sql(`SELECT to_jsonb(t) FROM ${relation} t ORDER BY to_jsonb(t)::text;`)).map(value => JSON.parse(value))
  return rows
}

async function scenario(session, name, manager) {
  const label = name
  const aliases = { 'estimate-dispatched': 'estimate-work', 'estimate-reanalysis-dispatched': 'estimate-reanalysis', 'activation-dispatched': 'activation-work', 'pick-values-dispatched': 'pick-values-work', 'process-dispatched': 'process-trades' }
  name = aliases[name] ?? name
  const f = await session.value(`SELECT to_jsonb(f)||jsonb_build_object('players',(SELECT jsonb_object_agg(team,ids) FROM (SELECT team,jsonb_agg(id ORDER BY slot) ids FROM actions_players GROUP BY team)p)) FROM actions_fixture f;`)
  const team = manager + 2, recipient = team + 1, third = team + 2
  const a = f.member_ids[team - 1], b = f.member_ids[recipient - 1], c = f.member_ids[third - 1]
  const user = f.user_ids[team - 1], other = f.user_ids[recipient - 1]
  const pa = f.players[team][0], pb = f.players[recipient][0], pc = f.players[third][0]
  const items = [{ fromMemberId: a, toMemberId: b, playerId: pa }, { fromMemberId: b, toMemberId: a, playerId: pb }]
  const multiItems = [{ fromMemberId: a, toMemberId: b, playerId: pa }, { fromMemberId: b, toMemberId: c, playerId: pb }, { fromMemberId: c, toMemberId: a, playerId: pc }]
  const terms = { leagueId: f.league_id, leagueSeasonId: f.season_id, recipientMemberId: b, offerPlayerIds: [pa], requestPlayerIds: [pb], offerFaabAmount: 1, requestFaabAmount: 1 }
  const body = { memberId: a, requestId, ...terms }
  let actor = user, trade = null, endpoint = '/trades/propose', handler = 'action', expected = 200
  const propose = async (proposer = a, receiver = b, offered = pa, requested = pb) => await session.value(`SELECT to_jsonb(${call('submit_trade_offer_atomic', [f.user_ids[f.member_ids.indexOf(proposer)], sourceRequest, proposer, 'propose', JSON.stringify({ ...terms, recipientMemberId: receiver, offerPlayerIds: [offered], requestPlayerIds: [requested] })])});`)
  if (['counter-multi', 'edit-multi', 'accept-multi'].includes(name)) {
    trade = await session.value(`SELECT to_jsonb(${call('submit_trade_offer_atomic', [user, sourceRequest, a, 'propose-multi', JSON.stringify({ ...terms, participantMemberIds: [a, b, c], items: multiItems })])});`)
  } else if (!['propose', 'propose-multi', 'estimate-quote', 'pick-values-work'].includes(name)) trade = await propose()
  if (trade) endpoint = `/trades/${trade}/${name}`
  if (['counter', 'reject', 'accept', 'accept-plan', 'accept-conflicts', 'accept-stale', 'accept-expired', 'accept-unauthorized'].includes(name)) { actor = other; body.memberId = b }
  if (name === 'counter') { body.offerPlayerIds = [pb]; body.requestPlayerIds = [pa]; delete body.recipientMemberId }
  if (name === 'edit') body.notes = 'Updated offer'
  if (name === 'counter-multi' || name === 'edit-multi') {
    body.participantMemberIds = [a, b, c]
    body.items = multiItems
    body.notes = 'Updated multi-team offer'
    if (name === 'counter-multi') { actor = other; body.memberId = b }
  }
  if (name === 'withdraw') body.memberId = a
  if (name === 'propose-multi') {
    endpoint = '/trades/propose-multi'
    body.participantMemberIds = [a, b, c]
    body.items = multiItems
  }
  if (name.startsWith('accept')) {
    endpoint = `/trades/${trade}/accept`
    if (name === 'accept-multi') {
      await session.sql(`SELECT set_config('request.headers','{}',true); SELECT set_config('pancake.request_active','',true); SELECT public.accept_trade_atomic(${quote(trade)},${quote(b)});`)
      actor = f.user_ids[third - 1]; body.memberId = c
    }
    if (name === 'accept-plan') body.rosterPlan = { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [], rosterMoves: [] }
    if (name === 'accept-conflicts') {
      await session.sql(`SELECT set_config('pancake.request_active','',true); SELECT public.propose_trade_atomic(${[f.league_id,f.season_id,a,c].map(quote).join(',')},ARRAY[${quote(pa)}]::uuid[],ARRAY[${quote(pc)}]::uuid[],'{}','{}');`)
    }
    if (name === 'accept-expired') { await session.sql(`UPDATE public.trades SET expires_at='2026-10-29' WHERE id=${quote(trade)};`); expected = 400 }
    if (name === 'accept-stale') { await session.sql(`SET LOCAL session_replication_role=replica; DELETE FROM public.roster_players WHERE league_season_id=${quote(f.season_id)} AND player_id=${quote(pa)}; SET LOCAL session_replication_role=origin;`); expected = 409 }
    if (name === 'accept-unauthorized') { actor = user; expected = 404 }
  }
  if (['commissioner-veto', 'member-veto', 'process-trades', 'activation-work', 'activation-noop', 'accepted-drop', 'accepted-ir', 'accepted-taxi', 'accepted-lineup'].includes(name)) {
    await session.sql(`SELECT set_config('request.headers','{}',true); SELECT set_config('pancake.request_active','',true); SELECT public.accept_trade_atomic(${quote(trade)},${quote(b)});`)
    if (name === 'commissioner-veto') { endpoint = `/trades/${trade}/veto`; actor = f.user_ids[0]; body.memberId = f.member_ids[0] }
    if (name === 'member-veto') { endpoint = `/trades/${trade}/veto`; actor = f.user_ids[third - 1]; body.memberId = c }
    if (['process-trades','activation-work','activation-noop'].includes(name)) await session.sql(`UPDATE public.trades SET veto_window_expires_at='2026-10-29' WHERE id=${quote(trade)};`)
    if (name.startsWith('activation')) {
      await session.sql(`SELECT public.complete_accepted_trade_atomic(${quote(trade)}); SELECT set_config('pancake.trade_write','',true);`)
      if (name === 'activation-work') {
        await session.sql(`UPDATE public.leagues SET status='drafting' WHERE id=${quote(f.league_id)};
          INSERT INTO public.drafts(league_id,league_season_id,draft_type,status,is_mock,rounds) VALUES(${quote(f.league_id)},${quote(f.season_id)},'snake','completed',false,3);`)
      }
      handler = 'activation'; body.tradeId = trade
    }
    if (name === 'process-trades') handler = 'process'
  }
  if (name === 'commissioner-approve') endpoint = `/trades/${trade}/approve`
  if (name === 'estimate-quote') { endpoint = '/trades/estimate'; body.items = items }
  if (name === 'estimate-work') { handler = 'estimate'; body.tradeId = trade }
  if (name === 'estimate-replay' || name === 'estimate-reanalysis') {
    const inputs = await session.value(`SELECT public.get_trade_revaluation_inputs(${quote(user)},${quote(a)},${quote(trade)})-ARRAY['revaluationTradeId','inputVersion','observedAt','cachedRevaluation'];`)
    await session.sql(`SELECT public.save_trade_estimate_quote(${quote(user)},${quote(a)},${quote(JSON.stringify({ ...inputs, submittedTradeId: trade }))}::jsonb,'{"teams":[],"assets":[]}','onenumber-trade-curve-v5');`)
    handler = 'estimate'; body.tradeId = trade
    if (name === 'estimate-reanalysis') { body.reanalysisVersion = 'onenumber-trade-curve-v5'; body.runVersion = 'trade-actions-reanalysis' }
  }
  if (name === 'pick-values-work') {
    handler = 'picks'
    body.sourceVersion = await session.value('SELECT to_jsonb(content_sha256) FROM private.trade_value_sync_state WHERE id;')
  }
  if (name === 'pending-drop' || name === 'pending-ir' || name === 'pending-taxi' || name.startsWith('accepted-')) {
    handler = 'sql'
    const id = await session.value(`SELECT to_jsonb(id) FROM public.roster_players WHERE league_season_id=${quote(f.season_id)} AND player_id=${quote(pa)};`)
    body.sql = name.endsWith('drop') ? `SELECT to_jsonb(public.drop_player_atomic(${quote(id)}))` : `WITH r AS (UPDATE public.roster_players SET ${name.endsWith('ir') ? 'is_on_ir' : 'is_on_taxi'}=true WHERE id=${quote(id)} RETURNING id) SELECT to_jsonb(id) FROM r`
  }
  if (name === 'pending-lineup' || name === 'accepted-lineup') {
    handler = 'sql'
    const week = await session.value("SELECT to_jsonb(week_number) FROM public.season_weeks WHERE season_year=2027 AND '2026-10-30'::date BETWEEN week_start AND week_end;")
    await session.sql(`INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${quote(f.league_id)},'PG',1),(${quote(f.league_id)},'BE',25) ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
      INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type) VALUES(${[f.league_id,f.season_id,a,pa,week,'2026-10-30','PG'].map(quote).join(',')});`)
    body.sql = `SELECT to_jsonb(public.set_player_slot_atomic(${[a,f.league_id,f.season_id,pa,'2026-10-30','BE',week].map(quote).join(',')}))`
  }
  await session.sql("SELECT set_config('pancake.request_active','',true); SELECT set_config('pancake.trade_write','',true); SELECT set_config('request.headers','{}',true); SELECT set_config('request.jwt.claim.sub','',true); SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;")
  let invocation
  if (aliases[label]) {
    const scopes = { estimate: ['trade-estimate', 'api/trades/estimate-work'], activation: ['trade-activation', 'api/trades/activation-work'], picks: ['pick-predictions', 'api/trades/pick-values-work'], process: ['process-trades', 'process-trades'] }
    const [kind, scope] = scopes[handler]
    const key = 'dddddddd-dddd-4ddd-8ddd-000000000001', token = 'eeeeeeee-eeee-4eee-8eee-000000000001'
    const work = await session.value(`INSERT INTO private.work_items(kind,key,payload,league_id,status,attempts,lease_token,lease_until,invocation_key)
      VALUES(${quote(kind)},'actions-harness',${quote(JSON.stringify(body))}::jsonb,${quote(f.league_id)},'running',1,${quote(token)},'2026-10-30T12:05:00Z',${quote(key)}) RETURNING to_jsonb(id);`)
    await session.sql(`INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token) VALUES(${quote(scope)},${quote(key)},${work},${quote(token)});`)
    invocation = { key, work }
  }
  return { name: label, manager, f, actor, body, endpoint, handler, expected, invocation }
}

async function invoke(s) {
  state.user = s.actor
  state.session.requests = 0
  errorId = 0
  const request = new Request(`http://127.0.0.1:64390${s.endpoint}`, { method: 'POST', headers: { authorization: 'Bearer private', 'content-type': 'application/json', 'x-request-id': requestId, 'x-internal-function-token': 'private-trade-harness', ...(s.invocation ? { 'x-pancake-invocation-id': s.invocation.key, 'x-pancake-work-id': String(s.invocation.work) } : {}) }, body: JSON.stringify(s.body) })
  let response
  if (s.handler === 'action') response = await handleApiRequest(request, 'trades-actions', async () => await handleTradeRoute(request, s.endpoint) ?? Response.json({ ok: false, error: 'Not found' }, { status: 404 }))
  else if (s.handler === 'estimate') response = await handleTradeEstimateWork(request)
  else if (s.handler === 'activation') response = await handleTradeActivationWork(request)
  else if (s.handler === 'picks') response = await handlePickPredictionWork(request)
  else if (s.handler === 'process') response = await processTrades(request)
  else {
    await state.session.sql(`SET LOCAL request.jwt.claim.sub=${quote(s.actor)};`)
    const result = await state.session.execute(s.body.sql, 'reservation-check')
    response = Response.json(result.error ? { error: result.error } : { data: result.data })
  }
  const bytes = await response.text()
  if (s.handler === 'action' && s.name !== 'commissioner-approve') assert.equal(response.status, s.expected, `${s.name}: ${bytes}`)
  if (s.name === 'commissioner-approve') assert.equal(response.status, 404)
  if (s.handler !== 'action' && s.handler !== 'sql') assert.equal(response.status, 200, `${s.name}: ${bytes}`)
  if (s.handler === 'sql') {
    if (s.name.endsWith('lineup')) assert.equal(JSON.parse(bytes).error, undefined, `${s.name} must allow lineup moves`)
    else assert.equal(JSON.parse(bytes).error?.code, 'PA004', `${s.name} must remain reserved`)
  }
  return { status: response.status, body: bytes }
}

async function sample(name, manager, variant, warm, audit) {
  const session = new SqlSession()
  state.session = session
  try {
    const definitions = candidateFiles.map(file => variant === 'baseline' ? execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8')).join('\n')
    await session.sql(`BEGIN; SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='5s'; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL track_functions='all'; SET LOCAL auto_explain.log_min_duration=-1; ${definitions}\n${labSetup}\n${sequenceReset.replace('2000000', '1000000')}\n${fixture}`)
    const s = await scenario(session, name, manager)
    await session.sql("SET LOCAL lock_timeout='10s';")
    if (audit) await session.sql(auditSetup)
    await session.sql(sequenceReset)
    await session.sql('DISCARD PLANS;')
    await session.sql('SAVEPOINT action;')
    if (warm) {
      await invoke(s)
      await session.sql('ROLLBACK TO action;')
      await session.sql(sequenceReset)
    }
    session.calls = []
    session.errors = ''
    const before = await session.value(writeCounters)
    const functionsBefore = await session.value(functionCounters)
    const starting = audit ? null : await session.value(`SELECT jsonb_build_object('work',(SELECT coalesce(jsonb_object_agg(kind,count),'{}') FROM (SELECT kind,count(*) FROM private.work_items GROUP BY kind)w),'notifications',(SELECT count(*) FROM public.notification_outbox));`)
    if (!audit) await session.sql('SELECT extensions.pg_stat_statements_reset();')
    if (!audit && traceEnabled) await session.sql("LOAD 'auto_explain'; SET LOCAL auto_explain.log_analyze=on; SET LOCAL auto_explain.log_buffers=on; SET LOCAL auto_explain.log_wal=on; SET LOCAL auto_explain.log_timing=off; SET LOCAL auto_explain.log_nested_statements=on; SET LOCAL auto_explain.log_format=json; SET LOCAL auto_explain.log_level=notice; SET LOCAL auto_explain.sample_rate=1; SET LOCAL auto_explain.log_min_duration=0;")
    session.profile = !audit
    const response = JSON.stringify(await invoke(s))
    session.profile = false
    const costs = !audit ? await session.value(statementCounters) : { calls: session.calls.length, statements: 0, milliseconds: 0, hits: 0, reads: 0, wal: 0 }
    if (!audit) assert.equal(costs.calls, session.calls.length, 'Every application query needs complete statement counters')
    if (!audit && traceEnabled) await session.sql('SET LOCAL auto_explain.log_min_duration=-1;')
    const after = await session.value(writeCounters)
    const functionsAfter = await session.value(functionCounters)
    let rows = audit ? await snapshot(session) : null
    const ending = audit ? null : await session.value(`SELECT jsonb_build_object('work',(SELECT coalesce(jsonb_object_agg(kind,count),'{}') FROM (SELECT kind,count(*) FROM private.work_items GROUP BY kind)w),'notifications',(SELECT count(*) FROM public.notification_outbox));`)
    const trace = nestedPlans(session.errors)
    const top = trace.filter(p => p['Query Text'].startsWith('SELECT trades_actions_lab.execute('))
    if (!audit && traceEnabled) assert.equal(top.length, session.calls.length, 'Every application query needs a complete cost plan')
    const followups = audit ? null : { work: Object.fromEntries([...new Set([...Object.keys(starting.work), ...Object.keys(ending.work)])].map(key => [key, (ending.work[key] ?? 0) - (starting.work[key] ?? 0)]).filter(([, value]) => value)), notifications: ending.notifications - starting.notifications }
    const functionCosts = Object.fromEntries(Object.entries(functionsAfter).map(([key, value]) => [key, { ...Object.fromEntries(['calls', 'self', 'total'].map(field => [field, value[field] - (functionsBefore[key]?.[field] ?? 0)])), isTrigger: value.isTrigger }]).filter(([, value]) => value.calls))
    const triggers = trace.flatMap(p => p.Triggers ?? [])
    const metrics = { ...costs, bytes: new TextEncoder().encode(JSON.parse(response).body).length,
      writes: Object.fromEntries(Object.entries(summary(after)).map(([key, value]) => [key, value - summary(before)[key]])),
      tableWrites: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([field, count]) => [field, count - (before[key]?.[field] ?? 0)]))]).filter(([, value]) => Object.values(value).some(Boolean))),
      triggerCalls: Object.values(functionCosts).filter(cost => cost.isTrigger).reduce((sum, cost) => sum + cost.calls, 0), triggers, functionCosts, followups }
    if (audit && Object.keys(rows).length) {
      const relations = Object.keys(rows)
      await session.sql(`ROLLBACK TO action; INSERT INTO trades_actions_touched VALUES ${relations.map(relation => `(${quote(relation)})`).join(',')} ON CONFLICT DO NOTHING;`)
      rows = { before: await snapshot(session), after: rows }
    }
    const key = `${name}-${manager}-${variant}-${warm ? 'warm' : 'fresh'}`
    if (!audit) {
      writeFileSync(path.join(output, `${key}-trace.log`), session.errors)
      writeFileSync(path.join(output, `${key}-calls.json`), JSON.stringify(session.calls))
    }
    return { name, manager, variant, warm, response, rows, hash: digest({ response, rows }), metrics }
  } finally { await session.close() }
}

const names = ['propose', 'counter', 'edit', 'accept', 'accept-plan', 'accept-conflicts', 'reject', 'withdraw', 'commissioner-veto', 'member-veto', 'commissioner-approve', 'propose-multi', 'counter-multi', 'edit-multi', 'accept-multi', 'estimate-quote', 'estimate-work', 'estimate-replay', 'estimate-reanalysis', 'activation-work', 'activation-noop', 'pick-values-work', 'process-trades', 'accept-stale', 'accept-expired', 'accept-unauthorized', 'pending-drop', 'pending-ir', 'pending-taxi', 'accepted-drop', 'accepted-ir', 'accepted-taxi', 'pending-lineup', 'accepted-lineup', 'estimate-dispatched', 'estimate-reanalysis-dispatched', 'activation-dispatched', 'pick-values-dispatched', 'process-dispatched'].filter(name => !only || only.split(',').some(item => name.split('-')[0] === item || name === item))
const started = RealDate.now()
try {
  const results = []
  for (let round = 0; round < (mode === 'measure' ? repeats : 1); round++) {
    for (const name of names) {
      for (let manager = 0; manager < (mode === 'measure' ? 1 : 3); manager++) {
        const pair = []
        for (const warm of mode === 'measure' ? [false, true] : [false]) {
          for (const variant of variants) {
            assert.ok(RealDate.now() - started < 60 * 60000, 'Split measurement batches before one hour')
            const result = await sample(name, manager, variant, warm, mode !== 'measure')
            pair.push(result)
            console.log(JSON.stringify({ name, manager, variant, warm, round, calls: result.metrics.calls, milliseconds: result.metrics.milliseconds, buffers: result.metrics.hits + result.metrics.reads, wal: result.metrics.wal, statements: result.metrics.statements, hash: result.hash }))
          }
          if (mode === 'measure') compare(pair.at(-2), pair.at(-1))
        }
        if (mode !== 'measure') {
          compare(pair[0], pair[1])
          assert.throws(() => compare(pair[0], { ...pair[1], response: `${pair[1].response} ` }), /response bytes/)
          const wrong = structuredClone(pair[1]); wrong.rows['negative.control'] = [{ changed: true }]
          assert.throws(() => compare(pair[0], wrong), /Touched table rows/)
        }
        results.push(...pair.map(result => ({ ...compact(result), round })))
        writeFileSync(path.join(output, 'results.json'), JSON.stringify(results))
      }
    }
  }
  console.log(JSON.stringify({ passed: true, mode, scenarios: names.length, samples: results.length, negativeControls: mode !== 'measure' ? results.length : 0 }))
} finally {
  await server.shutdown()
}
