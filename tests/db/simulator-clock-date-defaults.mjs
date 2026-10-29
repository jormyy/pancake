import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const db = process.env.SUPABASE_DB_URL
assert.ok(db, 'SUPABASE_DB_URL is required')
const connection = new URL(db)
const port = process.env.PANCAKE_TEST_DB_PORT ?? '54322'
assert.ok(['127.0.0.1', 'localhost'].includes(connection.hostname) && connection.port === port)
connection.username = 'supabase_admin'
const table = `sim_clock_date_${randomUUID().replaceAll('-', '')}`
const unsupported = `${table}_unsupported`
const checks = []
const execute = args => spawnSync('psql', [connection.href, '-XqAtv', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' })
const sql = source => {
  const result = execute(['-c', source])
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const file = (name, at) => execute(['-v', `season_sim_port=${port}`, '-v', `sim_ms=${Date.parse(at)}`, '-v', `real_ms=${Date.now()}`, '-v', 'rate=0', '-v', `cap_ms=${Date.parse(at)}`, '-f', `scripts/season-sim/${name}.sql`])
const defaults = () => sql("SELECT md5(string_agg(format('%s.%s:%s',d.adrelid::regclass,a.attname,pg_get_expr(d.adbin,d.adrelid)),E'\\n' ORDER BY d.adrelid::regclass::text,a.attname)) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') OR (n.nspname='net' AND c.relname='_http_response')")
const literal = value => `'${value.replaceAll("'", "''")}'`
const jobs = JSON.parse(sql("SELECT COALESCE(json_agg(j),'[]') FROM (SELECT jobname,schedule,command,active FROM cron.job ORDER BY jobname) j"))
let installed = false
try {
  const audit = () => {
    const result = execute(['-f', 'scripts/season-sim/clock-audit.sql'])
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim())
  }
  const beforeAudit = audit()
  for (const form of ['current_timestamp', 'current_date', 'current_time', 'localtimestamp', 'localtime', 'timeofday']) {
    assert.equal(beforeAudit[form].objects.filter(object => !(form === 'current_date' && object.kind === 'default')).length, 0, `Uncovered SQL clock form: ${form}`)
  }
  checks.push('runtime-clock-audit-before-install')
  sql(`CREATE TABLE public.${table}(label text,day date DEFAULT CURRENT_DATE)`)
  const before = defaults()
  const native = sql("SELECT pg_get_functiondef('pg_catalog.now()'::regprocedure)")
  const result = file('clock', '2001-01-01T01:00:00Z')
  assert.equal(result.status, 0, result.stderr)
  installed = true
  const installedAudit = audit()
  for (const form of ['current_timestamp', 'current_date', 'current_time', 'localtimestamp', 'localtime', 'timeofday']) assert.equal(installedAudit[form].occurrences, 0, `Uncovered installed SQL clock form: ${form}`)
  for (const [form, entry] of Object.entries(installedAudit)) if (form.startsWith('season_sim_native_')) assert.equal(entry.occurrences, 0, `Native clock binding remains: ${form}`)
  checks.push('runtime-clock-audit-after-install')
  assert.equal(sql("BEGIN; INSERT INTO net._http_response(id,status_code) VALUES(-1,200) RETURNING created=now(); DELETE FROM net._http_response WHERE created<now()-interval '6 hours'; SELECT count(*) FROM net._http_response WHERE id=-1; ROLLBACK;"), 't\n1')
  checks.push('http-response-uses-business-clock-and-survives-retention')
  for (const birthdate of ['1899-12-31', '2001-01-02']) {
    const rejected = execute(['-c', `INSERT INTO public.players(first_name,last_name,position,birthdate) VALUES('Clock','Bounds','PG',DATE ${literal(birthdate)})`])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /players_birthdate_check/)
    checks.push(`birthdate-rejects-${birthdate}`)
  }
  assert.equal(sql("BEGIN; SET LOCAL ROLE service_role; INSERT INTO public.players(first_name,last_name,position,birthdate) VALUES('Clock','Today','PG',DATE '2001-01-01') RETURNING birthdate; ROLLBACK;"), '2001-01-01')
  checks.push('birthdate-accepts-simulated-today-for-worker')
  for (const [zone, expected] of [['UTC', '2001-01-01'], ['America/Los_Angeles', '2000-12-31']]) {
    assert.equal(sql(`SET TIME ZONE ${literal(zone)}; INSERT INTO public.${table}(label) VALUES(${literal(zone)}) RETURNING day`), expected)
    checks.push(`frozen-date-${zone}`)
  }
  const next = Date.parse('2001-01-03T01:00:00Z')
  sql(`UPDATE season_sim.clock SET sim_ms=${next},cap_ms=${next},rate=0`)
  assert.equal(sql(`SET TIME ZONE 'UTC'; INSERT INTO public.${table}(label) VALUES('next-day') RETURNING day`), '2001-01-03')
  checks.push('default-follows-new-business-day')
  sql(`CREATE TABLE public.${unsupported}(at timestamptz DEFAULT CURRENT_TIMESTAMP)`)
  const rejected = file('clock', '2005-01-01T00:00:00Z')
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Public defaults contain clock keywords/)
  assert.equal(sql('SELECT sim_ms::bigint FROM season_sim.clock'), String(next))
  sql(`DROP TABLE public.${unsupported}`)
  checks.push('unsupported-keyword-rejects-and-rolls-back')
  const restored = file('restore-clock', '2001-01-03T01:00:00Z')
  assert.equal(restored.status, 0, restored.stderr)
  installed = false
  assert.equal(defaults(), before, 'All application and HTTP response defaults restore exactly')
  assert.equal(sql("SELECT pg_get_functiondef('pg_catalog.now()'::regprocedure)"), native)
  checks.push('exact-default-and-native-clock-restoration')
  sql(`DROP TABLE public.${table}`)
  const afterDrop = defaults()
  const reinstalled = file('clock', '2001-01-04T01:00:00Z')
  assert.equal(reinstalled.status, 0, reinstalled.stderr)
  installed = true
  const restoredAgain = file('restore-clock', '2001-01-04T01:00:00Z')
  assert.equal(restoredAgain.status, 0, restoredAgain.stderr)
  installed = false
  assert.equal(defaults(), afterDrop)
  assert.equal(sql("SELECT pg_get_functiondef('pg_catalog.now()'::regprocedure)"), native)
  checks.push('fresh-cycle-excludes-dropped-fixture-defaults')
  console.log(JSON.stringify({ passed: true, checks, savedReplayTouched: false }))
} finally {
  if (installed) {
    const restored = file('restore-clock', '2001-01-03T01:00:00Z')
    assert.equal(restored.status, 0, restored.stderr)
  }
  sql(`DROP TABLE IF EXISTS public.${unsupported}; DROP TABLE IF EXISTS public.${table}`)
  for (const job of jobs) sql(`SELECT cron.schedule(${literal(job.jobname)},${literal(job.schedule)},${literal(job.command)}); SELECT cron.alter_job(jobid,active:=${job.active}) FROM cron.job WHERE jobname=${literal(job.jobname)}`)
}
