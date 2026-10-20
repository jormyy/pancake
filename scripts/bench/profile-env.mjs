import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const config = readFileSync('supabase/config.toml', 'utf8')
if (!/^project_id = "pt0493perf"$/m.test(config) || /543\d\d/.test(config)) throw Error('Use pt0493perf with every port shifted to 563xx')
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const values = Object.fromEntries(status.trim().split('\n').map(line => {
  const index = line.indexOf('=')
  return [line.slice(0,index), JSON.parse(line.slice(index+1))]
}))
for (const [name,port] of [['API_URL','56321'],['DB_URL','56322']]) {
  const url = new URL(values[name])
  if (!['localhost','127.0.0.1'].includes(url.hostname) || url.port !== port) throw Error('Unsafe local stack target')
}
const clockMode = process.argv.find(value => ['--clock','--restore-clock'].includes(value))
if (clockMode) {
  const directory = process.argv[process.argv.indexOf(clockMode)+1]
  if (!directory) throw Error('Clock mode requires an external evidence directory')
  const file = `${directory}/profile-clock-restore.sql`
  const timestampFile = `${directory}/profile-timestamp-restore.sql`
  const execute = sql => execFileSync('docker', ['exec','-i','supabase_db_pt0493perf','psql','-U','supabase_admin','-d','postgres','-X','-At','-v','ON_ERROR_STOP=1'], { input:sql,encoding:'utf8',stdio:['pipe','pipe','inherit'] })
  if (!existsSync(file)) writeFileSync(file,execute("SELECT pg_get_functiondef('pg_catalog.now()'::regprocedure);"))
  const original = readFileSync(file,'utf8')
  if (clockMode === '--restore-clock') {
    execute("DO $$ BEGIN IF to_regprocedure('pg_catalog.profile_real_now()') IS NOT NULL THEN DROP FUNCTION pg_catalog.now(); ALTER FUNCTION pg_catalog.profile_real_now() RENAME TO now; END IF; IF to_regprocedure('pg_catalog.profile_real_clock()') IS NOT NULL THEN DROP FUNCTION pg_catalog.clock_timestamp(); ALTER FUNCTION pg_catalog.profile_real_clock() RENAME TO clock_timestamp; END IF; END $$;")
    execute(original+';\n'+(existsSync(timestampFile) ? readFileSync(timestampFile,'utf8')+';\n' : ''))
  } else {
    if (!existsSync(timestampFile)) writeFileSync(timestampFile,execute("SELECT pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure);"))
    execute(original)
    execute("CREATE SCHEMA IF NOT EXISTS bench; CREATE TABLE IF NOT EXISTS bench.profile_clock(at timestamptz); TRUNCATE bench.profile_clock; INSERT INTO bench.profile_clock VALUES('2026-03-14T12:00:00Z'); ALTER FUNCTION pg_catalog.now() RENAME TO profile_real_now; CREATE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT at FROM bench.profile_clock$$; ALTER FUNCTION pg_catalog.clock_timestamp() RENAME TO profile_real_clock; CREATE FUNCTION pg_catalog.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$SELECT at FROM bench.profile_clock$$;")
  }
  console.log(clockMode === '--clock' ? 'Installed isolated benchmark clock' : 'Restored native database clock')
  process.exit(0)
}
if (process.argv.includes('--setup')) {
  execFileSync('docker', ['exec', 'supabase_db_pt0493perf', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
    "GRANT SET ON PARAMETER pg_stat_statements.track TO postgres; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO postgres; GRANT EXECUTE ON FUNCTION pg_stat_reset() TO postgres; GRANT SELECT,UPDATE ON cron.job TO postgres; GRANT pg_read_all_stats TO postgres; GRANT MAINTAIN ON net._http_response TO postgres; ALTER DATABASE postgres SET pg_stat_statements.track='all';"], { stdio: ['ignore','pipe','inherit'] })
}
const token = randomBytes(24).toString('hex')
const common = { PANCAKE_SUPABASE_SECRET_KEY: values.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: token }
const run = { ...common, SUPABASE_URL: values.API_URL, SUPABASE_DB_URL: values.DB_URL, SUPABASE_ANON_KEY: values.ANON_KEY }
writeFileSync('.env.perf-functions', Object.entries(common).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join('\n')+'\n', { mode: 0o600 })
writeFileSync('.env.perf-run', Object.entries(run).map(([key,value]) => `export ${key}='${String(value).replaceAll("'", "'\\''")}'`).join('\n')+'\n', { mode: 0o600 })
console.log('Generated local-only function and runner environment files')
