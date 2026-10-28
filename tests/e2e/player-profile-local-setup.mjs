import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export function privateProfileEnvironment(status) {
  assert.equal(status.API_URL, 'http://127.0.0.1:57721')
  return {
    EXPO_PUBLIC_SUPABASE_URL: status.API_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
    EXPO_PUBLIC_API_URL: `${status.API_URL}/functions/v1/api`,
    PANCAKE_SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
    PANCAKE_EDGE_INTERNAL_TOKEN: 'ui7-local-fixture-only',
    SUPABASE_DB_URL: status.DB_URL,
    E2E_ADMIN_SECRET: 'ui7-local-fixture-only',
    E2E_FRONTEND_URL: 'http://127.0.0.1:57780',
  }
}

function setupProfile() {
  const configPath = 'supabase/config.toml'
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(/^project_id = .*$/m, 'project_id = "pt4bafableui7"').replace(/\b543(\d\d)\b/g, '577$1').replace('inspector_port = 8083', 'inspector_port = 57783'))
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const values = privateProfileEnvironment(status)
  writeFileSync('.env', Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
  console.log('Private local environment created.')
  if (process.argv.includes('--build')) {
    execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], { stdio: 'inherit', env: { ...process.env, ...values, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', CI: '1' } })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) setupProfile()
