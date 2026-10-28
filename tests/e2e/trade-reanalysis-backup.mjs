import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
assert.equal(new URL(status.API_URL).origin, 'http://127.0.0.1:58121')
const database = 'postgresql://postgres:postgres@127.0.0.1:58122/postgres'
const sql = query => execFileSync('psql', [database, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: query, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
const json = query => JSON.parse(sql(query))
const nativeFetch = globalThis.fetch
const requests = []
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.equal(url.origin, 'http://127.0.0.1:58121', 'Only the private API may receive requests')
  requests.push(url.pathname)
  return nativeFetch(input, init)
}
globalThis.Deno.env.set('SUPABASE_URL', status.API_URL)
globalThis.Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', status.SECRET_KEY ?? status.SERVICE_ROLE_KEY)
globalThis.Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'pancake-local-p4math-token')
const shared = '../../supabase/functions/_shared/'
const api = '../../supabase/functions/api/'
const { supabase } = await import(shared + 'supabase.ts')
const { handleTradeEstimateWork } = await import(api + 'tradeEstimateWork.ts')
const { createTradeEstimate, revalueTrade } = await import(api + 'tradeEstimates.ts')
const { syncTradeValues } = await import(shared + 'tradeValues.ts')
const rpc = async (name, args = {}) => {
  const result = await supabase.rpc(name, args)
  if (result.error) throw result.error
  return result.data
}
const players = json("SELECT coalesce(json_agg(p),'[]') FROM (SELECT id,display_name,nba_team,position,eligible_positions FROM public.players) p")
const published = await syncTradeValues({
  players: async () => players, overrides: async () => ({}),
  publish: payload => rpc('publish_trade_values', { p_rows: payload.rows, p_picks: payload.picks, p_source_body: payload.source,
    p_fetched_at: payload.fetchedAt, p_mode: payload.mode, p_request_id: payload.requestId }),
}, { format: 'json', content: readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8') })
assert.ok(published.matched > 400)
const targets = json("SELECT coalesce(json_agg(t),'[]') FROM (SELECT id,league_id,status FROM public.trades WHERE status IN('pending','accepted','completed') ORDER BY id) t")
assert.ok(targets.length > 0, 'The backup must contain real trades')
const originals = json("SELECT coalesce(json_object_agg(t.id,jsonb_build_object('estimate',to_jsonb(e),'quote',to_jsonb(q))),'{}') FROM public.trades t LEFT JOIN public.trade_estimates e ON e.trade_id=t.id LEFT JOIN public.trade_estimate_quotes q ON q.id=e.quote_id WHERE t.status IN('pending','accepted','completed')")
assert.equal(sql("SELECT count(*) FROM public.trade_estimate_history WHERE formula_version='onenumber-trade-v1'"), '0')
await rpc('queue_trade_estimate_reanalysis')
let updated = 0
let batches = 0
while (true) {
  const item = json("SELECT coalesce((SELECT to_jsonb(w) FROM private.work_items w WHERE kind='trade-estimate' AND status='pending' AND payload->>'reanalysisVersion'='onenumber-trade-v1' ORDER BY id LIMIT 1),'null')")
  assert.ok(item, 'Every unfinished batch has a durable work item')
  const lease = crypto.randomUUID()
  const invocation = crypto.randomUUID()
  sql(`UPDATE private.work_items SET status='running',attempts=attempts+1,lease_token='${lease}',lease_until=now()+interval '5 minutes',invocation_key='${invocation}' WHERE id=${Number(item.id)} AND status='pending';
    INSERT INTO public.edge_invocations(function_name,request_id,invocation_key,work_item_id,work_lease_token)
    VALUES('api/trades/estimate-work',${-1000000 - Number(item.id)},'${invocation}',${Number(item.id)},'${lease}');`)
  const request = () => new Request('http://127.0.0.1:58121/functions/v1/api/trades/estimate-work', { method: 'POST',
    headers: { 'x-internal-function-token': 'pancake-local-p4math-token', 'content-type': 'application/json',
      'x-pancake-invocation-id': invocation, 'x-pancake-work-id': String(item.id) }, body: JSON.stringify(item.payload) })
  const response = await handleTradeEstimateWork(request())
  assert.equal(response.status, 200)
  const result = await response.json()
  updated += result.updated
  batches++
  assert.equal(sql(`SELECT status FROM private.work_items WHERE id=${Number(item.id)}`), 'succeeded')
  assert.equal(sql(`SELECT worker_status FROM public.edge_invocations WHERE invocation_key='${invocation}'`), 'success')
  if (result.remaining === 0) break
  assert.ok(batches < 1000)
}
assert.equal(updated, targets.length)
const snapshots = json("SELECT json_agg(h) FROM public.trade_estimate_history h")
assert.equal(snapshots.length, targets.length * 2)
for (const trade of targets) {
  const history = snapshots.filter(row => row.trade_id === trade.id)
  assert.deepEqual(history.find(row => row.formula_version === 'original').snapshot, originals[trade.id])
  const current = history.find(row => row.formula_version === 'onenumber-trade-v1')
  assert.equal(current.snapshot.model_version, 'onenumber-trade-v1')
  assert.equal(current.snapshot.inputs.revaluationTradeId, trade.id)
  assert.ok(current.snapshot.analysis.assets.length > 0)
}
const currentState = () => sql("SELECT md5(string_agg(row_to_json(q)::text,'' ORDER BY q.id)) FROM public.trade_estimate_quotes q")
const beforeReplay = currentState()
const replay = await handleTradeEstimateWork(new Request('http://127.0.0.1:58121/functions/v1/api/trades/estimate-work', { method: 'POST',
  headers: { 'x-internal-function-token': 'pancake-local-p4math-token', 'content-type': 'application/json' }, body: JSON.stringify({ reanalysisVersion: 'onenumber-trade-v1' }) }))
assert.deepEqual(await replay.json(), { ok: true, updated: 0, remaining: 0 })
assert.equal(currentState(), beforeReplay)
const actor = json("SELECT row_to_json(m) FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id JOIN public.leagues l ON l.id=t.league_id WHERE t.status IN('pending','completed') AND l.deleted_at IS NULL ORDER BY (t.status='pending') DESC LIMIT 1")
assert.ok(actor)
{
  const tradeId = sql(`SELECT id FROM public.trades WHERE proposer_member_id='${actor.id}' AND status IN('pending','completed') LIMIT 1`)
  const revaluation = await revalueTrade(actor.user_id, actor.id, tradeId)
  assert.deepEqual(Object.keys(revaluation).sort(), ['analysis','createdAt','expiresAt','inputVersion','modelVersion','seasonYear','terms','tradeId'].sort())
  const term = [{ fromMemberId: actor.id, toMemberId: sql(`SELECT id FROM public.league_members WHERE league_id='${actor.league_id}' AND id<>'${actor.id}' LIMIT 1`), playerId: null, pickId: null, faabAmount: 1 }]
  const quote = await createTradeEstimate(actor.user_id, actor.id, term)
  assert.deepEqual(Object.keys(quote).sort(), ['analysis','createdAt','expiresAt','id','inputVersion','modelVersion','seasonYear','terms'].sort())
  assert.equal(quote.modelVersion, 'onenumber-trade-v1')
}
console.log(JSON.stringify({ trades: targets.length, pending: targets.filter(t => t.status === 'pending').length,
  completed: targets.filter(t => t.status === 'completed').length, leagues: new Set(targets.map(t => t.league_id)).size,
  estimateShape: 'unchanged', revaluationShape: 'unchanged', batches, history: snapshots.length, replay: 'passed', originalSnapshots: 'exact', matchedValues: published.matched, requests: requests.length }))

if (globalThis.Deno.env.get('PANCAKE_VERIFY_PICK_PREDICTIONS') === '1') {
  const { handleApiRoute } = await import(api + 'router.ts')
  const run = async (kind, handler) => {
    const item = json(`SELECT coalesce((SELECT to_jsonb(w) FROM private.work_items w WHERE kind='${kind}' AND status='pending' ORDER BY id DESC LIMIT 1),'null')`)
    assert.ok(item)
    const lease = crypto.randomUUID()
    const invocation = crypto.randomUUID()
    const name = kind === 'pick-predictions' ? 'api/trades/pick-values-work' : 'api/trades/estimate-work'
    sql(`UPDATE private.work_items SET status='running',attempts=attempts+1,lease_token='${lease}',lease_until=now()+interval '5 minutes',invocation_key='${invocation}' WHERE id=${Number(item.id)};
      INSERT INTO public.edge_invocations(function_name,request_id,invocation_key,work_item_id,work_lease_token)
      VALUES('${name}',${-2000000 - Number(item.id)},'${invocation}',${Number(item.id)},'${lease}');`)
    const response = await handler(new Request(`http://127.0.0.1:58121/functions/v1/${name}`, { method: 'POST',
      headers: { 'x-internal-function-token': 'pancake-local-p4math-token', 'content-type': 'application/json',
        'x-pancake-invocation-id': invocation, 'x-pancake-work-id': String(item.id) }, body: JSON.stringify(item.payload) }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(sql(`SELECT status FROM private.work_items WHERE id=${Number(item.id)}`), 'succeeded')
    return response.json()
  }
  assert.equal(sql("SELECT count(*) FROM private.work_items WHERE kind='trade-estimate' AND payload->>'runVersion'='onenumber-trade-v1-picks-v1'"), '0')
  const prediction = await run('pick-predictions', handleApiRoute)
  const picks = json("SELECT json_agg(p) FROM (SELECT predicted_tier_odds AS odds,predicted_trade_value AS value,predicted_value_bands AS bands FROM public.draft_picks WHERE round BETWEEN 1 AND 3) p")
  assert.ok(picks.length > 0)
  for (const pick of picks) {
    assert.ok(pick.odds)
    assert.ok(Math.abs(pick.odds.early + pick.odds.mid + pick.odds.late - 1) < 1e-8)
    assert.ok(pick.value >= Math.min(pick.bands.early, pick.bands.late) - 1e-6)
    assert.ok(pick.value <= Math.max(pick.bands.early, pick.bands.late) + 1e-6)
  }
  let refreshed = 0
  while (sql("SELECT count(*) FROM public.get_trade_estimate_reanalysis_batch('onenumber-trade-v1-picks-v1')") !== '0') {
    const result = await run('trade-estimate', handleTradeEstimateWork)
    refreshed += result.updated
  }
  assert.equal(refreshed, targets.length)
  const retainedOriginals = json("SELECT json_object_agg(trade_id,snapshot) FROM public.trade_estimate_history WHERE formula_version='original'")
  for (const trade of targets) assert.deepEqual(retainedOriginals[trade.id], originals[trade.id])
  assert.equal(sql("SELECT count(*) FROM public.trade_estimate_history WHERE formula_version='onenumber-trade-v1-picks-v1'"), String(targets.length))
  assert.equal(await rpc('queue_trade_estimate_reanalysis', { p_run: 'onenumber-trade-v1-picks-v1' }), 0)
  assert.equal(sql("SELECT count(*) FROM private.work_kinds WHERE kind='sync-rankings'"), '0')
  assert.equal(sql("SELECT to_regproc('private.enqueue_rankings') IS NULL"), 't')
  assert.equal(sql("SELECT count(*) FROM cron.job WHERE jobname LIKE '%rankings%' OR command LIKE '%sync-rankings%'"), '0')
  console.log(JSON.stringify({ predictedPicks: picks.length, prediction, refreshedTrades: refreshed, originalHistory: 'preserved', rankingWork: 'removed', odds: 'normalized', values: 'bounded' }))
}
