import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

assert.equal(process.cwd(), resolve(homedir(), 'pancake-t_4ba51e0d/lanes/post/repo'))
const keys = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
assert.equal(new URL(keys.API_URL).port, '57421')
assert.equal(new URL(keys.DB_URL).port, '57422')
for (const target of [keys.API_URL, keys.DB_URL]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
const env = { ...process.env, PANCAKE_TEST_API_PORT: '57421', PANCAKE_TEST_DB_PORT: '57422', SUPABASE_DB_URL: keys.DB_URL, SUPABASE_URL: keys.API_URL, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: keys.ANON_KEY, E2E_SUPABASE_PUBLISHABLE_KEY: keys.PUBLISHABLE_KEY ?? keys.ANON_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token' }
const file = process.argv[2]
assert.ok(file && /^(tests\/db|supabase\/tests\/db|supabase\/functions\/_shared|tests\/e2e)\//.test(file))
const command = file.endsWith('.sql') ? ['psql', [keys.DB_URL, '-Xv', 'ON_ERROR_STOP=1', '-f', file]] : file.endsWith('.mjs') ? ['node', [file]] : ['deno', ['run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql', file]]
console.log(`${command[0]} ${command[1].map(arg => arg === keys.DB_URL ? '"$SUPABASE_DB_URL"' : arg).join(' ')}`)
const started = performance.now()
const result = spawnSync(command[0], command[1], { env, stdio: 'inherit', timeout: 120_000 })
console.log(`exit=${result.status} seconds=${((performance.now()-started)/1000).toFixed(2)} signal=${result.signal}`)
process.exit(result.status ?? 125)
