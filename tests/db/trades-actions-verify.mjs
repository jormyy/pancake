import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

assert.equal(process.cwd(), path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a1/repo'))
const config = readFileSync('supabase/config.toml', 'utf8')
assert.match(config, /project_id = "pt4bafablea1"/)
assert.match(config, /port = 64322/)
try {
  writeFileSync('supabase/config.toml', config.replace(/(\[db.migrations\][\s\S]*?enabled = )false/, '$1true'))
  execFileSync('supabase', ['migration', 'up', '--local', '--include-all'], { stdio: 'inherit' })
} finally { writeFileSync('supabase/config.toml', config) }
const env = { ...process.env, SUPABASE_DB_URL: 'postgresql://supabase_admin:postgres@127.0.0.1:64322/postgres', PANCAKE_TEST_DB_PORT: '64322' }
for (const args of [['tests/db/trades-actions-regressions.mjs'], ['tests/db/trades-actions-deno.mjs'],
  ['scripts/check-db-function-sources.mjs', '--check-catalog'], ['scripts/regenerate-release-history-attestations.mjs']]) {
  execFileSync('node', args, { env, stdio: 'inherit' })
}
