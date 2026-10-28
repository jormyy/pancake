import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const database = new URL(process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:57822/postgres')
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname) && database.port === '57822', 'Only the private trade-value stack is allowed')
const sql = source => execFileSync('psql', [database.href, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const fixture = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
let checks = 0
const check = (actual, expected, message) => { assert.equal(actual, expected, message); checks++ }
const checkTrue = value => { assert.ok(value); checks++ }
const request = async body => {
  const response = await fetch('http://127.0.0.1:57821/functions/v1/sync-trade-values', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': 'pancake-local-edge-auth-probe-token' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  check(response.status, 200, JSON.stringify(result))
  return result.result
}

const result = await request({ format: 'json', content: fixture })
check(result.players, 450)
checkTrue(result.matched >= 441)
check(result.matched + result.unmatched, 450)
check(result.picks, 18)
check(result.derivedPicks, 9)
check(Number(sql("SELECT count(*) FROM public.dynasty_rankings WHERE source='onenumberhoops.com'")), 450)
check(Number(sql("SELECT trade_value FROM public.dynasty_rankings WHERE source_player_id='victorwembanyama' AND source='onenumberhoops.com'")), 999.9)
check(Number(sql('SELECT count(*) FROM public.dynasty_pick_values')), 27)
check(Number(sql('SELECT count(*) FROM public.trade_value_reviews WHERE resolved_player_id IS NULL')), result.unmatched)

const identities = JSON.parse(sql(`BEGIN; ${readFileSync('tests/db/rules-support.sql', 'utf8')}
SELECT row_to_json(fixture) FROM pg_temp.rules_fixture(2,2027,'active') fixture; COMMIT;`))
const auth = (user, statement, admin = false) => sql(`BEGIN;
SELECT set_config('request.jwt.claim.sub','${user}',true);
SELECT set_config('request.jwt.claims','${JSON.stringify({ sub: user, role: 'authenticated', app_metadata: admin ? { role: 'admin' } : {} })}',true);
SET LOCAL ROLE authenticated;
${statement}
ROLLBACK;`).split('\n').at(-1)

try {
  const leader = identities.user_ids[0]
  const manager = identities.user_ids[1]
  const league = identities.league_id
  check(Number(auth(leader, 'SELECT count(*) FROM public.trade_value_reviews;')), result.unmatched)
  check(Number(auth(manager, 'SELECT count(*) FROM public.trade_value_reviews;')), 0)
  check(Number(auth(manager, 'SELECT count(*) FROM public.trade_value_reviews;', true)), result.unmatched)
  check(Number(auth(leader, `SELECT count(*) FROM public.get_dynasty_forecast_inputs('${league}','${identities.member_ids[0]}',2027,NULL,'',600,0) WHERE trade_value IS NOT NULL;`)), result.matched)
  check(Number(auth(leader, `SELECT max(trade_value) FROM public.get_dynasty_forecast_inputs('${league}','${identities.member_ids[0]}',2027,NULL,'',600,0);`)), 999.9)
  check(Number(auth(leader, `SELECT count(*) FROM public.get_dynasty_pick_values('${league}');`)), 27)
  check(Number(auth(leader, `SELECT min(trade_value) FROM public.get_dynasty_pick_values('${league}') WHERE round=3;`)), 500)
  const replacement = JSON.parse(sql("SELECT json_build_object('id',player_id,'value',trade_value) FROM public.dynasty_rankings WHERE source='onenumberhoops.com' AND player_id IS NOT NULL AND trade_value BETWEEN 150 AND 250 ORDER BY abs(trade_value-200) LIMIT 1;"))
  check(Number(auth(leader, `RESET ROLE;
    INSERT INTO analytics.player_season_totals(player_id,season_year,games_played,points,points_count) VALUES('${replacement.id}',2027,1,50,1);
    SET LOCAL ROLE authenticated;
    SELECT min(trade_value) FROM public.get_dynasty_pick_values('${league}') WHERE round=3;`)), replacement.value)
  const pickId = sql(`INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES('${league}',2028,1,'${identities.member_ids[0]}','${identities.member_ids[0]}')
    ON CONFLICT(league_id,season_year,round,original_owner_id) DO UPDATE SET current_owner_id=EXCLUDED.current_owner_id RETURNING id;`)
  const terms = [{ fromMemberId: identities.member_ids[0], toMemberId: identities.member_ids[1], pickId }]
  const inputs = JSON.parse(sql(`SELECT public.get_trade_estimate_inputs('${leader}','${identities.member_ids[0]}','${JSON.stringify(terms)}'::jsonb);`))
  check(inputs.picks[0].valueBands.early, 750.1)
  checkTrue(Number.isFinite(Date.parse(inputs.picks[0].valueFetchedAt)))
  check(Number(auth(leader, `SELECT public.resolve_trade_value_review('alexcaruso',(SELECT candidate_ids[1] FROM public.trade_value_reviews WHERE source_id='alexcaruso'));
    SELECT count(*) FROM public.dynasty_rankings WHERE source='onenumberhoops.com' AND source_player_id='alexcaruso' AND player_id IS NOT NULL;`)), 1)
  assert.throws(() => auth(manager, "SELECT public.resolve_trade_value_review('alexcaruso',gen_random_uuid());"), /Only commissioners and admins/)
  checks++
  const denied = await fetch('http://127.0.0.1:57821/functions/v1/sync-trade-values', { method: 'POST', body: '{}' })
  check(denied.status, 401)

  const source = JSON.parse(fixture)
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
  const csv = ['source_id,name,team,positions,rank,value,age', ...source.data.map(row => [row.id, row.player, row.team, row.pos, row.rank, row.value, row.age].map(quote).join(','))].join('\n')
  const csvResult = await request({ format: 'csv', content: csv })
  check(csvResult.matched, result.matched)
  const before = sql("SELECT content_sha256 FROM private.trade_value_sync_state WHERE id")
  const broken = await fetch('http://127.0.0.1:57821/functions/v1/sync-trade-values', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': 'pancake-local-edge-auth-probe-token' },
    body: JSON.stringify({ format: 'json', content: '{"success":true,"data":[]}' }),
  })
  check(broken.status, 500)
  check(sql('SELECT content_sha256 FROM private.trade_value_sync_state WHERE id'), before)
  console.log(JSON.stringify({ passed: checks, players: result.players, matched: result.matched, review: result.unmatched, picks: 27, csv: 'passed', rollback: 'passed', access: 'passed' }))
} finally {
  sql(`DELETE FROM public.leagues WHERE id='${identities.league_id}'; DELETE FROM auth.users WHERE id IN('${identities.user_ids.join("','")}');`)
}
