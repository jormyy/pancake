import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { command } from '../../../scripts/perf-lab/process.mjs'
import { localKeys } from './database.mjs'
import { labRoot, project } from './common.mjs'

assert.equal(project, 'pt4bafablec1')
const arm = process.argv[2]
assert.ok(['baseline', 'candidate'].includes(arm))
const root = arm === 'baseline' ? path.join(labRoot, 'baseline') : process.cwd()
const keys = await localKeys()
const temporary = path.join(labRoot, `build-cache-${arm}`)
await mkdir(temporary, { recursive: true })
const result = await command('npm', ['run', 'build:web:release'], { cwd: root, timeout: 600000, env: {
    ...process.env, EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:64921', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:64981/functions/v1/api',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1',
    PANCAKE_FETCH_PREDECESSOR: '0', VERCEL_ENV: 'development', CI: '1', TMPDIR: temporary,
} })
console.log(result.stdout.slice(-2500))
console.log(`Stamped ${arm} release build complete.`)
