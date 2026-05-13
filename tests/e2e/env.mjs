import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

export const loadEnvFile = (filePath) => {
  if (!existsSync(filePath)) return
  const contents = readFileSync(filePath, 'utf8')
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]] != null) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}

loadEnvFile(path.join(ROOT, '.env'))
loadEnvFile(path.join(ROOT, 'backend/.env'))

export const envValue = (...names) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  return undefined
}

export const resolvedEnv = () => ({
  supabaseUrl: envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL'),
  serviceRoleKey: envValue(
    'E2E_PANCAKE_SUPABASE_SECRET_KEY',
    'PANCAKE_SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ),
  anonKey: envValue(
    'E2E_SUPABASE_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'E2E_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  ),
  apiBaseUrl: envValue('E2E_API_BASE_URL', 'EXPO_PUBLIC_API_URL') ?? 'http://127.0.0.1:3000',
  frontendUrl: envValue('E2E_FRONTEND_URL') ?? 'http://127.0.0.1:8081',
  e2eAdminSecret: envValue('E2E_ADMIN_SECRET'),
  backendTicksEnabled: envValue('E2E_ENABLE_BACKEND_TICKS') === '1',
})

export const requireEnv = (env, keys) => {
  const missing = keys.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required E2E environment: ${missing.join(', ')}`)
  }
}

export const describeEndpoint = (value) => {
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      ? url.origin
      : '<remote configured>'
  } catch {
    return '<configured>'
  }
}
