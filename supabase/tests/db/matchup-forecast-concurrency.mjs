import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createSqlSession } from '../../../scripts/season-sim/sql-session.mjs'

const target = new URL(process.env.SUPABASE_DB_URL)
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT)
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
Object.assign(env, { PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: 'postgres',
  PGUSER: 'supabase_admin', PGPASSWORD: decodeURIComponent(target.password), PGPASSFILE: '/dev/null', PGSSLMODE: 'disable' })
const sessions = []
function session() {
  const result = createSqlSession('psql', env, ['-XqAt', '--set', 'ON_ERROR_STOP=1', '--set', 'VERBOSITY=verbose'])
  sessions.push(result)
  return result
}
const observer = session(), gate = session(), publisher = session(), scorer = session(), otherPublisher = session()
const id = randomUUID(), otherId = randomUUID(), token = randomUUID(), suffix = id.replaceAll('-', '')
const schema = `forecast_probe_${suffix}`
const app = `forecast-${suffix}`
const json = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const q = async statement => JSON.parse(await observer.query(statement))
let fixture, year, pending = []
const locks = () => q(`SELECT coalesce(json_agg(r),'[]') FROM (
  SELECT pid,application_name,wait_event,pg_blocking_pids(pid) blockers
  FROM pg_stat_activity WHERE application_name LIKE '${app}%') r`)
async function waitFor(predicate) {
  for (let index = 0; index < 300; index++) {
    const value = await locks()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Forecast overlap barrier was not reached')
}
const state = () => q(`SELECT json_build_object(
  'points',(SELECT home_points FROM public.matchups WHERE id='${id}'),
  'queue',(SELECT row_to_json(q) FROM private.matchup_forecast_queue q WHERE matchup_id='${id}'),
  'cache',(SELECT row_to_json(f) FROM public.matchup_forecasts f WHERE matchup_id='${id}'))`)
function checkCurrent(value, revision, forecast) {
  assert.equal(value.points, 101)
  assert.equal(value.queue.dirty, false)
  assert.equal(value.queue.claim_token, null)
  assert.equal(value.cache.input_revision, revision)
  assert.deepEqual(value.cache.forecast, forecast)
}
try {
  await observer.query(`BEGIN; ${await readFile(new URL('../../../tests/db/rules-support.sql', import.meta.url), 'utf8')} COMMIT;`)
  year = Number(await observer.query(`SELECT candidate FROM generate_series(9580,9699) candidate
    WHERE NOT EXISTS(SELECT 1 FROM public.season_weeks WHERE season_year=candidate)
      AND NOT EXISTS(SELECT 1 FROM public.league_seasons WHERE season_year=candidate) LIMIT 1`))
  assert.ok(year)
  fixture = await q(`SELECT row_to_json(f) FROM pg_temp.rules_fixture(2,${year}) f`)
  await observer.query(`INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(${year},1,(now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+6);
    INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES('${id}','${fixture.league_id}','${fixture.season_id}',1,'${fixture.member_ids[0]}','${fixture.member_ids[1]}',0,0);
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(${year},2,(now() AT TIME ZONE 'America/New_York')::date+7,(now() AT TIME ZONE 'America/New_York')::date+13);
    INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES('${otherId}','${fixture.league_id}','${fixture.season_id}',2,'${fixture.member_ids[0]}','${fixture.member_ids[1]}',0,0);
    UPDATE private.matchup_forecast_queue SET claimed_at=now(),claim_token='${token}',claimed_revision=revision,
      changed_at=now()-interval '1 second' WHERE matchup_id IN ('${id}','${otherId}');
    CREATE SCHEMA ${schema};
    CREATE FUNCTION ${schema}.pause_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(578,hashtext('${id}')); RETURN NEW; END $$;
    CREATE TRIGGER ${schema} BEFORE INSERT ON public.matchup_forecasts FOR EACH ROW
      WHEN (NEW.matchup_id='${id}'::uuid) EXECUTE FUNCTION ${schema}.pause_insert();`)
  const lease = (await state()).queue
  const forecast = { modelVersion: 'concurrency-fixture', teams: fixture.member_ids.map(memberId => ({ memberId, currentPoints: 0 })) }
  await gate.query(`SET application_name='${app}-gate'; BEGIN; SELECT pg_advisory_xact_lock(578,hashtext('${id}'))`)
  await publisher.query(`SET application_name='${app}-publisher'; SET statement_timeout='15s'`)
  await scorer.query(`SET application_name='${app}-scorer'; SET statement_timeout='15s'`)
  const publishing = publisher.query(`SELECT public.complete_matchup_forecast('${id}',${lease.revision},'${token}',${json(forecast)},now()+interval '1 hour')`)
    .then(value => ({ value }), error => ({ error: String(error) }))
  pending.push(publishing)
  await waitFor(rows => rows.some(row => row.application_name === `${app}-publisher` && row.wait_event === 'advisory'))
  await otherPublisher.query("SET statement_timeout='2s'")
  assert.equal(await otherPublisher.query(`SELECT public.complete_matchup_forecast('${otherId}',1,'${token}',${json(forecast)},now()+interval '1 hour')`), 't')
  const scoring = scorer.query(`SELECT public.update_score_points_atomic('${fixture.league_id}','${fixture.season_id}',1,
    ${json([{ id, home_points: 101, away_points: 90 }])})`)
    .then(value => ({ value }), error => ({ error: String(error) }))
  pending.push(scoring)
  const blocked = await waitFor(rows => rows.some(row => row.application_name === `${app}-scorer` && row.blockers.length))
  const writer = blocked.find(row => row.application_name === `${app}-publisher`)
  assert.ok(blocked.find(row => row.application_name === `${app}-scorer`).blockers.includes(writer.pid))
  await gate.query('COMMIT')
  assert.deepEqual(await publishing, { value: 't' })
  assert.deepEqual(await scoring, { value: '1' })
  const invalidated = await state()
  assert.equal(invalidated.points, 101)
  assert.equal(invalidated.queue.dirty, true)
  assert.equal(invalidated.cache.input_revision, lease.revision)
  assert.ok(invalidated.queue.revision > lease.revision)
  const revision = invalidated.queue.revision
  await observer.query(`DROP TRIGGER ${schema} ON public.matchup_forecasts;
    UPDATE private.matchup_forecast_queue SET claim_token='${token}',claimed_revision=${lease.revision},claimed_at=now() WHERE matchup_id='${id}'`)
  assert.equal(await observer.query(`SELECT public.complete_matchup_forecast('${id}',${lease.revision},'${token}',${json(forecast)},now()+interval '1 hour')`), 'f')
  assert.equal((await state()).cache.input_revision, lease.revision)
  assert.equal((await state()).queue.claim_token, null)
  const retryToken = randomUUID()
  await observer.query(`UPDATE private.matchup_forecast_queue SET claim_token='${retryToken}',claimed_revision=revision,claimed_at=now() WHERE matchup_id='${id}'`)
  assert.equal(await observer.query(`SELECT public.fail_matchup_forecast('${id}','${token}','expired worker')`), 'f')
  assert.equal((await state()).queue.claim_token, retryToken)
  assert.equal(await observer.query(`SELECT public.complete_matchup_forecast('${id}',${revision},'${token}',${json(forecast)},now()+interval '1 hour')`), 'f')
  assert.equal(await observer.query(`SELECT public.fail_matchup_forecast('${id}','${retryToken}','retry fixture')`), 't')
  const retry = (await state()).queue
  assert.equal(retry.dirty, true)
  assert.equal(retry.claim_token, null)
  assert.equal(retry.last_error, 'retry fixture')
  assert.ok(Date.parse(retry.available_at) > Date.parse(await observer.query('SELECT now()')))
  await observer.query(`UPDATE private.matchup_forecast_queue SET claim_token='${retryToken}',claimed_revision=revision,claimed_at=now() WHERE matchup_id='${id}'`)
  forecast.teams[0].currentPoints = 101
  forecast.teams[1].currentPoints = 90
  assert.equal(await observer.query(`SELECT public.complete_matchup_forecast('${id}',${revision},'${retryToken}',${json(forecast)},now()+interval '1 hour')`), 't')
  checkCurrent(await state(), revision, forecast)
  await observer.query(`UPDATE public.matchup_forecasts SET input_revision=input_revision+1 WHERE matchup_id='${id}'`)
  await assert.rejects(async () => checkCurrent(await state(), revision, forecast))
  await observer.query(`UPDATE public.matchup_forecasts SET input_revision=${revision} WHERE matchup_id='${id}'`)
  checkCurrent(await state(), revision, forecast)
  await observer.query(`SET request.jwt.claim.sub='${fixture.user_ids[0]}'`)
  assert.equal((await q(`SELECT public.get_matchup_forecast('${id}')`)).stale, false)
  await observer.query(`SET request.jwt.claim.sub='${randomUUID()}'`)
  await assert.rejects(() => observer.query(`SELECT public.get_matchup_forecast('${id}')`), /42501/)
  console.log(JSON.stringify({ passed: true, observedBlocking: true, parallelCompletion: true, staleResultRejected: true,
    tokenFenced: true, retryPreserved: true, corruptionDetected: true, outsiderRejected: true }))
} finally {
  await gate.query('ROLLBACK').catch(() => {})
  await Promise.allSettled(pending)
  await observer.query(`DROP TRIGGER IF EXISTS ${schema} ON public.matchup_forecasts; DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  if (fixture) {
    await observer.query(`DELETE FROM public.leagues WHERE id='${fixture.league_id}'; DELETE FROM auth.users WHERE id IN (${fixture.user_ids.map(id => `'${id}'`).join(',')})`)
  }
  if (year) await observer.query(`DELETE FROM public.season_weeks WHERE season_year=${year}`)
  await Promise.all(sessions.map(value => value.close()))
}
