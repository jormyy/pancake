import { sql } from './stack-sql.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { lane } from './lane.mjs'
import { startEdge, stopEdge } from './edge.mjs'

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
execFileSync('supabase', process.argv.includes('--reset') ? ['db', 'reset', '--local', '--no-seed'] : ['migration', 'up', '--local'], { stdio: 'inherit' })
await sql('SELECT cron.unschedule(jobid) FROM cron.job')
await stopEdge()
await startEdge()
console.log('post stack and real Edge server ready; synthetic local data only')
