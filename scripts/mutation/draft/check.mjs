import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const values = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
for (const [target, port] of [[values.API_URL, '57921'], [values.DB_URL, '57922']]) {
  const url = new URL(target)
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port, 'Use only the draft test stack')
}
const env = { ...process.env, PANCAKE_TEST_API_PORT: '57921', PANCAKE_TEST_DB_PORT: '57922', SUPABASE_URL: values.API_URL, SUPABASE_DB_URL: values.DB_URL, PANCAKE_SUPABASE_SECRET_KEY: values.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token' }
const file = process.argv[2]
assert(file && /^(tests\/db\/draft-timer-|supabase\/tests\/db\/draft-|tests\/e2e\/(draft-timer-|expired-draft-outcomes))/.test(file))
const command = file.endsWith('.sql') ? 'psql' : 'node'
const args = file.endsWith('.sql') ? [values.DB_URL, '-Xv', 'ON_ERROR_STOP=1', '-f', file] : [file]
console.log(`${command} ${file}`)
const started = performance.now()
const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 120000 })
console.log(`exit=${result.status} seconds=${((performance.now()-started)/1000).toFixed(2)}`)
process.exit(result.status ?? 125)
