import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'
import { command, delay, digest, json, loopback, quote, readJson, repository } from './common.mjs'
import { createSqlSession } from '../../season-sim/sql-session.mjs'

async function freePorts() {
  const first = randomInt(1900, 2350) * 20
  for (let base = first; base < 48000; base += 20) {
    const servers = []
    try {
      for (let i = 0; i < 12; i++) {
        const server = net.createServer()
        servers.push(server)
        await new Promise((resolve, reject) => server.once('error', reject).listen(base + i, '127.0.0.1', resolve))
      }
      return base
    } catch {} finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))) }
  }
  throw new Error('No free local port block')
}

async function removeStack(evidence, project, temporaryImages = []) {
  assert.match(project, /^pancake-game-night-[a-f0-9]{10}$/)
  const workdir = path.join(evidence, 'runtime', project)
  await command('docker', ['rm', '-f', `${project}-relay`], { allowFailure: true })
  await command('supabase', ['stop', '--project-id', project, '--no-backup', '--workdir', workdir], { file: path.join(evidence, 'setup-stop.log') })
  for (const image of temporaryImages) {
    assert.equal(image, `${project}-rest:local`)
    await command('docker', ['image', 'rm', image], { allowFailure: true })
  }
  const remaining = (await command('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`])).stdout.trim()
  assert.equal(remaining, '', 'Disposable stack did not stop')
  await json(path.join(evidence, 'cleanup.json'), { stopped: true, project, at: new Date().toISOString() })
}

export async function stopRecordedStack(evidence, expectedProject) {
  const { project } = await readJson(path.join(evidence, 'environment.json'))
  assert.equal(project, expectedProject, 'Recorded project does not match the requested cleanup')
  await removeStack(evidence, project, [`${project}-rest:local`])
}

export async function startStack(evidence, { sourceRoot = repository, profileMemory = false, sharedBuffers } = {}) {
  if (sharedBuffers != null) assert.match(sharedBuffers, /^[1-9][0-9]*(kB|MB|GB)$/)
  const project = `pancake-game-night-${randomBytes(5).toString('hex')}`
  const base = await freePorts()
  const ports = { api: base, db: base + 1, shadow: base + 2, studio: base + 3, mail: base + 4, pool: base + 5, analytics: base + 6, inspector: base + 7, edge: base + 8, feed: base + 9, public: base + 10 }
  const workdir = path.join(evidence, 'runtime', project)
  await mkdir(path.join(workdir, 'supabase'), { recursive: true, mode: 0o700 })
  let config = await readFile(path.join(sourceRoot, 'supabase/config.toml'), 'utf8')
  config = config.replace(/^project_id = .*$/m, `project_id = "${project}"`)
    .replace(/\b54321\b/g, ports.api).replace(/\b54322\b/g, ports.db).replace(/\b54320\b/g, ports.shadow)
    .replace(/\b54323\b/g, ports.studio).replace(/\b54324\b/g, ports.mail).replace(/\b54329\b/g, ports.pool)
    .replace(/\b54327\b/g, ports.analytics).replace(/\b8083\b/g, ports.inspector)
    .replace(/env\([^)]+\)/g, '').replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
    .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false')
  await writeFile(path.join(workdir, 'supabase/config.toml'), config)
  await cp(path.join(sourceRoot, 'supabase/migrations'), path.join(workdir, 'supabase/migrations'), { recursive: true })
  const container = `supabase_db_${project}`
  const cli = args => command('supabase', [...args, '--workdir', workdir], { file: path.join(evidence, `setup-${args[0]}.log`) })
  const owned = async name => {
    const result = JSON.parse((await command('docker', ['inspect', '--format', '{"labels":{{json .Config.Labels}},"healthcheck":{{json .Config.Healthcheck}},"image":{{json .Config.Image}},"networks":{{json .NetworkSettings.Networks}}}', name])).stdout)
    assert.equal(result.labels?.['com.supabase.cli.project'], project, 'Refuse an unowned container')
    return result
  }
  const sqlOnce = async statement => {
    await owned(container)
    return (await command('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement })).stdout.trim()
  }
  let session
  let runtimeClose
  let stopping
  const temporaryImages = []
  const stop = async () => {
    stopping ??= (async () => {
      await runtimeClose?.()
      await session?.close()
      await removeStack(evidence, project, temporaryImages)
    })()
    return stopping
  }
  try {
    await cli(['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
    await sqlOnce("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET pg_stat_statements.track='all'; ALTER SYSTEM SET track_functions='all'; SELECT pg_reload_conf();")
    if (sharedBuffers != null) {
      await sqlOnce(`ALTER SYSTEM SET shared_buffers=${quote(sharedBuffers)};`)
      await command('docker', ['restart', container])
      let ready = false
      for (let attempt = 0; attempt < 60; attempt++) {
        try { await sqlOnce('SELECT 1'); ready = true; break } catch { await delay(500) }
      }
      assert.ok(ready, 'The local database does not restart with shared_buffers')
    }
    await writeFile(path.join(workdir, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    await cli(['migration', 'up', '--local', '--include-all'])
    const keys = JSON.parse((await command('supabase', ['status', '-o', 'json', '--workdir', workdir])).stdout)
    const api = loopback(keys.API_URL, [ports.api]).origin
    const db = loopback(keys.DB_URL, [ports.db])
    const env = { PATH: process.env.PATH, PGHOST: '127.0.0.1', PGHOSTADDR: '127.0.0.1', PGPORT: String(ports.db), PGUSER: 'supabase_admin', PGPASSWORD: decodeURIComponent(db.password), PGDATABASE: 'postgres', PGPASSFILE: '/dev/null', PGSSLMODE: 'disable', PGAPPNAME: 'game-night-observer' }
    session = createSqlSession('psql', env)
    const sql = statement => session.query(statement)
    await sql("SET pg_stat_statements.track='none';")
    const resetObserver = async () => {
      await session.close()
      session = createSqlSession('psql', env)
      await sql("SET pg_stat_statements.track='none';")
    }
    const sqlFile = async (file, { allowFailure = false, output } = {}) => {
      const testEnv = { ...env, PGUSER: 'postgres', PANCAKE_TEST_DB_PORT: String(ports.db), SUPABASE_DB_URL: db.href }
      const input = (await readFile(file, 'utf8')).replaceAll("'http://127.0.0.1:1'", quote(`http://127.0.0.1:${ports.edge}`)).replace(/^\\getenv (\w+) (\w+)$/gm, (_, variable, name) => {
        assert.ok(name === 'PANCAKE_TEST_DB_PORT', `Unsupported test environment variable: ${name}`)
        return `\\set ${variable} ${testEnv[name]}`
      })
      return command('psql', ['-Xq', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input, cwd: path.dirname(file), env: testEnv, allowFailure, file: output })
    }
    if (profileMemory) await sql(`CREATE FUNCTION public.game_night_memory_contexts() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
      SELECT jsonb_build_object('pid',pg_backend_pid(),'contexts',coalesce(jsonb_agg(jsonb_build_object('name',name,'ident',ident,'parent',parent,'totalBytes',total_bytes,'usedBytes',used_bytes) ORDER BY total_bytes DESC),'[]')) FROM pg_backend_memory_contexts
    $$; REVOKE ALL ON FUNCTION public.game_night_memory_contexts() FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.game_night_memory_contexts() TO service_role;`)
    const token = randomBytes(32).toString('hex')
    await sql(`ALTER DATABASE postgres SET app.supabase_url=${quote(`http://127.0.0.1:${ports.edge}`)}; ALTER DATABASE postgres SET app.edge_internal_token=${quote(token)};`)
    await sql(`CREATE SCHEMA game_night;
      CREATE FUNCTION game_night.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.url !~ '^http://127[.]0[.]0[.]1:${ports.edge}/functions/v1/[a-z-]+$'
        AND NOT EXISTS(SELECT 1 FROM private.work_kinds WHERE NEW.url='http://127.0.0.1:${ports.edge}/functions/v1/'||function_name)
        THEN RAISE EXCEPTION 'Game-night blocks external HTTP'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER game_night_local_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION game_night.local_http_only();`)
    let rejected = false
    try { await sql("SELECT net.http_post('https://example.invalid','{}'::jsonb);") } catch (error) { rejected = error.message.includes('Game-night blocks external HTTP') }
    assert.ok(rejected, 'SQL outbound guard must reject an external URL')
    await sql(`BEGIN; SELECT net.http_post('http://127.0.0.1:${ports.edge}/functions/v1/api/trades/estimate-work','{}'::jsonb); ROLLBACK;`)
    await sql("SET pg_stat_statements.track='none';")
    await command('docker', ['run', '-d', '--name', `${project}-relay`, '--network', `container:${container}`, '--label', `com.supabase.cli.project=${project}`, 'node:22.22.0-bookworm-slim', 'node', '-e', `require('net').createServer(s=>{const t=require('net').connect(${ports.edge},'host.docker.internal');s.pipe(t);t.pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy())}).listen(${ports.edge},'127.0.0.1')`])
    const cron = JSON.parse(await sql("SELECT json_agg(r ORDER BY jobname) FROM (SELECT jobname,schedule,command,active FROM cron.job) r"))
    assert.ok(cron.some(row => row.jobname.includes('dispatch')), 'Real dispatcher cron is missing')
    assert.ok(cron.every(row => !/https?:\/\/[^\s']*supabase\.co/.test(row.command)), 'Cron contains a remote endpoint')
    const migrations = await readdir(path.join(sourceRoot, 'supabase/migrations'))
    const hashes = Object.fromEntries(await Promise.all(migrations.filter(file => file.endsWith('.sql')).sort().map(async file => [file, digest(await readFile(path.join(sourceRoot, 'supabase/migrations', file)))])))
    const metadata = { project, ports, source: (await command('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot })).stdout.trim(), sourceRoot, migrations: hashes, cron, settings: { sharedBuffers: sharedBuffers ?? null }, clock: 'native real time; no SQL clock replacement', network: 'Database HTTP guard and loopback relay; Edge fetch guard and Deno allow-net', host: JSON.parse((await command('docker', ['info', '--format', '{{json .}}'])).stdout) }
    metadata.host = Object.fromEntries(['NCPU', 'MemTotal', 'KernelVersion', 'CgroupVersion', 'OperatingSystem'].map(key => [key, metadata.host[key]]))
    await json(path.join(evidence, 'environment.json'), metadata)
    await json(path.join(evidence, 'database-healthcheck.json'), (await owned(container)).healthcheck)
    await json(path.join(evidence, 'schema.json'), JSON.parse(await sql("SELECT json_agg(c) FROM (SELECT table_schema,table_name,column_name,data_type,column_default FROM information_schema.columns WHERE table_schema IN ('public','private','analytics') ORDER BY table_schema,table_name,ordinal_position)c")))
    return { project, ports, container, workdir, sourceRoot, profileMemory, temporaryImages, api, db: db.href, keys, token, sql, sqlFile, sqlOnce, resetObserver, stop, metadata, evidence, owned, setRuntimeClose(close) { runtimeClose = close } }
  } catch (error) { await stop(); throw error }
}
