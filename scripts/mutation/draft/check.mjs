import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { ownedStack } from '../identity/t10-rerun.mjs'

const { keys, ports, env: stackEnv } = ownedStack()
const env = { ...stackEnv, E2E_API_BASE_URL: `${keys.API_URL}/functions/v1/api`, E2E_FRONTEND_URL: `http://127.0.0.1:${ports.api.slice(0, 3)}80`, E2E_ADMIN_SECRET: 'draft-round2-local-admin', E2E_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY, SUPABASE_ANON_KEY: keys.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY }
const file = process.argv[2]
assert(file && /^(test:db:[a-z-]+|(?:tests\/(?:db|e2e)|supabase\/tests\/db)\/[A-Za-z0-9_-]+\.(?:sql|mjs|ts))$/.test(file))
const command = file.startsWith('test:db:') ? 'npm' : file.endsWith('.sql') ? 'psql' : file.endsWith('.ts') ? 'deno' : 'node'
const args = command === 'npm' ? ['run', file] : command === 'psql' ? [keys.DB_URL, '-Xv', 'ON_ERROR_STOP=1', '-f', file] : command === 'deno' ? ['run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', '--allow-run=psql', file] : [file]
console.log(`${command} ${file}`)
const started = performance.now()
const result = spawnSync(command, args, { env, stdio: 'inherit', timeout: 120000 })
console.log(`exit=${result.status} seconds=${((performance.now()-started)/1000).toFixed(2)}`)
process.exit(result.status ?? 125)
