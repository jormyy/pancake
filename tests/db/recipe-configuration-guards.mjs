import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const databaseUrl = process.env.SUPABASE_DB_URL
assert.ok(databaseUrl, 'SUPABASE_DB_URL is required')
const target = new URL(databaseUrl)
const config = readFileSync('supabase/config.toml', 'utf8')
const port = config.match(/^\[db\]\n(?:(?!\[)[^\n]*\n)*?port\s*=\s*(\d+)\s*$/m)?.[1]
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Use a private local database')
assert.equal(target.port, port, 'Use this checkout database port')

const files = readdirSync('tests/db').filter(file => file.endsWith('.sql'))
  .map(file => `tests/db/${file}`).filter(file => /^\s*\\getenv /m.test(readFileSync(file, 'utf8'))).sort()
assert.ok(files.length > 0, 'Database recipes must include their configuration guards')
const invalidEnvironment = { ...process.env, PANCAKE_TEST_DB_PORT: '1', PANCAKE_TEST_API_PORT: '1' }
delete invalidEnvironment.SUPABASE_DB_URL
delete invalidEnvironment.SUPABASE_URL
const failures = []
for (const file of files) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    env: invalidEnvironment, encoding: 'utf8', timeout: 30_000,
  })
  assert.ifError(result.error)
  if (result.status !== 3 || !result.stderr.includes('ERROR:')) failures.push(`${file}: exit ${result.status}`)
}
assert.deepEqual(failures, [], 'Invalid configuration must fail before a database recipe runs')
console.log(`PASS configuration guards: ${files.length} recipes reject invalid settings`)
