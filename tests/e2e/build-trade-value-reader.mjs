import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
assert.equal(status.API_URL, 'http://127.0.0.1:57821')
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', '../reader-web'], {
  stdio: 'inherit',
  env: { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_SUPABASE_URL: status.API_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY, EXPO_PUBLIC_API_URL: `${status.API_URL}/functions/v1/api` },
})
const directory = '../reader-web/_expo/static/js/web'
const source = readdirSync(directory).filter(file => file.endsWith('.js')).map(file => readFileSync(path.join(directory, file), 'utf8')).join('')
assert.ok(source.includes(status.API_URL), 'Build uses the assigned private stack')
assert.ok(!source.includes('http://127.0.0.1:58021'), 'Build does not reuse the other local stack')
assert.ok(!source.includes('ceeytbfmwsnzalxlkalc.supabase.co'), 'Build does not contain the production API URL')
console.log('Private build URL checks passed')
