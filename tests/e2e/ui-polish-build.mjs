import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { command } from '../../scripts/perf-lab/process.mjs'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableup"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:62821')
const { origin } = JSON.parse(await readFile('../browser-origin.json', 'utf8'))
assert.equal(new URL(origin).port, '62884')
await command('node', ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear'], { timeout: 240000, env: { ...process.env, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', EXPO_PUBLIC_SUPABASE_URL: origin, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.ANON_KEY } })
console.log('Private browser artifact rebuilt.')
