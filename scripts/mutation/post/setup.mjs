import { sql } from './stack-sql.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const lane = resolve(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), resolve(lane, 'repo'))
const db = 'postgresql://postgres:postgres@127.0.0.1:57422/postgres'
assert.equal(new URL(db).hostname, '127.0.0.1')
assert.equal(new URL(db).port, '57422')
mkdirSync(`${lane}/evidence`, { recursive: true })
let config = readFileSync('supabase/config.toml', 'utf8')
config = config.replace(/^project_id = .*$/m, 'project_id = "pt4bapost"').replace(/\b543(\d\d)\b/g, '574$1').replace('inspector_port = 8083', 'inspector_port = 57483')
config = config.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1false').replace(/(\[db.seed\][\s\S]*?enabled = )(?:true|false)/, '$1false')
writeFileSync('supabase/config.toml', config)
execFileSync('supabase', ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'], { stdio: 'inherit' })
await sql("ALTER SYSTEM SET cron.launch_active_jobs = 'off'")
await sql('SELECT pg_reload_conf()')
writeFileSync('supabase/config.toml', config.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1true'))
execFileSync('supabase', ['migration', 'up', '--local'], { stdio: 'inherit' })
await sql('SELECT cron.unschedule(jobid) FROM cron.job')
writeFileSync(`${lane}/edge.env`, 'PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token\n')
const { openSync } = await import('node:fs')
const edge = spawn('supabase', ['functions', 'serve', '--env-file', `${lane}/edge.env`], { env: { ...process.env, PATH: `${lane}/bin:${process.env.PATH}`, DOCKER_CONFIG: `${lane}/docker-config` }, detached: true, stdio: ['ignore', openSync(`${lane}/evidence/edge.log`, 'a'), openSync(`${lane}/evidence/edge.log`, 'a')] })
writeFileSync(`${lane}/edge.pid`, String(edge.pid))
edge.unref()
let ready = false
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:57421/functions/v1/season-boundary')
    if ([401,403].includes(response.status)) { ready = true; break }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(ready, 'The real Edge server must reject unauthenticated requests before tests start')
console.log('post stack and real Edge server ready; synthetic local data only')
