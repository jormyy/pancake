import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chunkBackup } from './l3e-chunk-backup.mjs'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a4')
const shared = path.join(homedir(), 'pancake-t_4ba51e0d/shared')
const project = 'pt4bafablea4'
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const run = (name, args, input) => {
  const result = spawnSync(name, args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr || result.stdout || result.error}`)
  return result.stdout
}
const sql = input => run('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], input)
const lock = name => {
  const directory = path.join(shared, name)
  try { mkdirSync(directory) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))
    let alive = true
    try { process.kill(owner.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') alive = false; else throw failure }
    if (alive && Date.now() - Date.parse(owner.started ?? owner.startedAt) <= 10800000) return null
    rmSync(directory, { recursive: true })
    mkdirSync(directory)
  }
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ lane: 'fable-a4', pid: process.pid, started: new Date().toISOString() }))
  return () => {
    const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))
    assert.equal(owner.pid, process.pid)
    rmSync(directory, { recursive: true })
  }
}
const releaseSlot = lock('stack-slot-5.lock')
assert.ok(releaseSlot, 'Reserved league stack slot 5 is occupied')
const original = readFileSync('supabase/config.toml', 'utf8')
let started = false
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try {
    if(started) for(let attempt=0;;attempt++) {
      try { run('supabase',['stop','--project-id',project]); break } catch(error) {
        if(attempt===5) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)
      }
    }
  } finally {
    writeFileSync('supabase/config.toml', original)
    rmSync(path.join(lane, 'backup'), { recursive: true, force: true })
    releaseSlot()
  }
}
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => { cleanup(); process.exit(1) })
try {
  const config = original.replace(/^project_id = .*$/m, `project_id = "${project}"`).replace(/\b543(\d\d)\b/g, '646$1').replace('inspector_port = 8083', 'inspector_port = 64683')
    .replace(/(\[db.migrations\][\s\S]*?enabled = )true/, '$1false').replace(/(\[db.seed\][\s\S]*?enabled = )true/, '$1false')
  writeFileSync('supabase/config.toml', config)
  started = true
  process.stdout.write('Starting pt4bafablea4.\n')
  run('supabase', ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,realtime,storage-api,edge-runtime,postgres-meta,gotrue,kong,postgrest'])
  const restartNeeded=sql('SHOW shared_buffers;').trim()!=='224MB'
  sql("ALTER SYSTEM SET cron.launch_active_jobs='off'; ALTER SYSTEM SET shared_buffers='224MB'; ALTER SYSTEM SET effective_cache_size='384MB'; SELECT pg_reload_conf();")
  if (!existsSync(path.join(lane, 'restored'))) {
    const prefix = path.join(lane, 'prefix')
    mkdirSync(path.join(prefix, 'supabase/migrations'), { recursive: true })
    writeFileSync(path.join(prefix, 'supabase/config.toml'), config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
    const baseline = '20261029000800'
    const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.*\.sql$/.test(file)).sort()
    for (const file of files.filter(file => file.slice(0, 14) <= baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Applying backup baseline.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    sql(`CREATE SCHEMA IF NOT EXISTS league_actions_lab;
CREATE OR REPLACE FUNCTION league_actions_lab.local_http_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF NEW.url !~ '^http://(127[.]0[.]0[.]1|localhost|host[.]lima[.]internal):646[0-9]{2}(/|$)' THEN RAISE EXCEPTION 'Private stack blocks external HTTP'; END IF; RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS league_actions_http ON net.http_request_queue;
CREATE TRIGGER league_actions_http BEFORE INSERT OR UPDATE ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION league_actions_lab.local_http_only();`)
    const manifest = JSON.parse(readFileSync(path.join(lane, 'backup/manifest.json'), 'utf8'))
    for (const file of ['schema.sql', 'data.sql']) assert.equal(createHash('sha256').update(readFileSync(path.join(lane, 'backup', file))).digest('hex'), manifest[file])
    const data = readFileSync(path.join(lane, 'backup/data.sql'), 'utf8')
    assert.ok(readFileSync(path.join(lane, 'backup/schema.sql'), 'utf8').includes('CREATE TABLE'))
    const chunked = chunkBackup(data)
    const verified = chunkBackup(chunked.sql, Number.MAX_SAFE_INTEGER)
    assert.equal(verified.valuesSha256, chunked.valuesSha256)
    assert.equal(verified.rows, chunked.rows)
    const tables = [...new Set([...data.matchAll(/^INSERT INTO ("[a-z_]+"\."[a-z_]+")\s*\(/gm)].map(match => match[1]))]
    sql(`ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS versioning_status text NOT NULL DEFAULT 'DISABLED', ADD COLUMN IF NOT EXISTS lifecycle_configuration jsonb, ADD COLUMN IF NOT EXISTS lifecycle_configuration_generation uuid;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS is_delete_marker boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS is_versioned boolean NOT NULL DEFAULT false;`)
    process.stdout.write(`Restoring ${chunked.rows} rows.\n`)
    sql(`BEGIN; SET LOCAL session_replication_role=replica; TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE;\n${chunked.sql}\nTRUNCATE auth.sessions,auth.refresh_tokens,auth.mfa_amr_claims,public.web_push_subscriptions,public.notification_outbox CASCADE; TRUNCATE net.http_request_queue;
UPDATE public.profiles SET push_token=NULL,push_token_revocation_hash=NULL;
UPDATE auth.users SET encrypted_password='',confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token=''; COMMIT;`)
    rmSync(path.join(lane, 'backup'), { recursive: true })
    for (const file of files.filter(file => file.slice(0, 14) > baseline)) cpSync(`supabase/migrations/${file}`, `${prefix}/supabase/migrations/${file}`)
    process.stdout.write('Migrating to branch.\n')
    run('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', prefix])
    rmSync(prefix, { recursive: true })
    writeFileSync(path.join(lane, 'restored'), new Date().toISOString())
  }
  if (process.argv.includes('--migrate')) {
    writeFileSync('supabase/config.toml',config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/,'$1true'))
    run('supabase',['migration','up','--local','--include-all'])
    writeFileSync('supabase/config.toml',config)
  }
  sql('SELECT cron.unschedule(jobid) FROM cron.job; ANALYZE;')
  for(let attempt=0;;attempt++) {
    try { run('docker',['update','--cpus=2','--memory=1g','--memory-swap=1g',`supabase_db_${project}`]); break } catch(error) {
      if(attempt===5) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)
    }
  }
  if(restartNeeded) run('docker', ['restart', `supabase_db_${project}`])
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnSync('docker', ['exec', `supabase_db_${project}`, 'pg_isready', '-U', 'supabase_admin']).status === 0) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.equal(run('docker', ['inspect', '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}', `supabase_db_${project}`]).trim(), '2000000000 1073741824')
  assert.equal(sql('SHOW shared_buffers; SHOW effective_cache_size;').trim(), '224MB\n384MB')
  mkdirSync(path.join(lane,'evidence'),{recursive:true})
  writeFileSync(path.join(lane,'evidence/stack.json'),JSON.stringify({at:new Date().toISOString(),project,node:process.version,cpus:2,memoryBytes:1073741824,sharedBuffers:'224MB',effectiveCacheSize:'384MB',concurrentWithOtherLanes:true,slot:5},null,2)+'\n')
  const split = process.argv.indexOf('--')
  assert.ok(split >= 0)
  const result = spawnSync(process.argv[split + 1], process.argv.slice(split + 2), { stdio: 'inherit', timeout: 1800000 })
  assert.equal(result.status, 0, String(result.error ?? 'Child failed'))
} finally { cleanup() }
