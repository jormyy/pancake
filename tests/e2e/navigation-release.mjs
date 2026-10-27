import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rename } from 'node:fs/promises'
import path from 'node:path'
import { resolvedEnv, requireEnv } from './env.mjs'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'anonKey'])
const url = new URL(env.supabaseUrl)
assert.equal(url.hostname, '127.0.0.1')
assert.match(url.port, /^598\d\d$/)
const original = path.resolve('release-predecessor.json')
const saved = path.resolve('../navigation-release-predecessor.json')
let moved = false
try {
  await rename(original, saved)
  moved = true
  const result = spawnSync('npm', ['run', 'build:web:release'], {
    stdio: 'inherit',
    env: { ...process.env, PANCAKE_PREVIOUS_RELEASE_ROOT: '', EXPO_PUBLIC_SUPABASE_URL: env.supabaseUrl,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.anonKey, EXPO_PUBLIC_API_URL: `${env.supabaseUrl}/functions/v1/api` },
  })
  assert.equal(result.status, 0, 'The isolated navigation release must finish')
} finally {
  if (moved) await rename(saved, original)
}
