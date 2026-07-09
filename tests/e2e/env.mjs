import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const DEFAULT_PRODUCTION_SUPABASE_REF = 'ceeytbfmwsnzalxlkalc'

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

export const envValue = (...names) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  return undefined
}

export const commandText = (command, args) => [command, ...args].join(' ')

export const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 30000,
    env: process.env,
  })

  return {
    command: commandText(command, args),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

export const statusFrom = (condition, blocked = 'BLOCKED') => (condition ? 'PASS' : blocked)

export const cleanMessage = (text, { maxLines = 10 } = {}) => String(text ?? '')
  .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
  .replaceAll(/\bsb_secret_[A-Za-z0-9_-]+\b/g, '[redacted-secret-key]')
  .replaceAll(/\bsb_publishable_[A-Za-z0-9_-]+\b/g, '[redacted-publishable-key]')
  .replaceAll(/(x-internal-function-token["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-internal-token]')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(0, maxLines)
  .join(' / ')

export const extractJson = (text) => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`Could not parse Supabase JSON output: ${cleanMessage(text)}`)
  return JSON.parse(text.slice(start, end + 1))
}

export const querySupabaseDb = (target, label, sql, timeout = 45000) => {
  const args = ['db', 'query', '--output', 'json', '--agent', 'yes']
  if (target === 'linked') args.push('--linked')
  args.push(sql)

  const result = runCommand('supabase', args, { timeout })
  if (result.status !== 0) {
    throw new Error(`${target} ${label}: ${cleanMessage(result.stderr || result.stdout || result.error?.message)}`)
  }

  return extractJson(result.stdout).rows ?? []
}

export const localSupabaseStatus = () => {
  const result = runCommand('supabase', ['status', '-o', 'json', '--agent', 'yes'])
  if (result.status !== 0) {
    throw new Error(cleanMessage(result.stderr || result.stdout || result.error?.message))
  }
  return extractJson(result.stdout)
}

export const writeMarkdownReport = async ({ reportPath, title, rows, columns }) => {
  const blockers = rows.filter((row) => row.status !== 'PASS')
  const cell = (value) => String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>')
  const lines = [
    `# ${title}`,
    '',
    `- Status: ${blockers.length === 0 ? 'PASS' : 'BLOCKED'}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    `| ${columns.map((column) => column.header).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => cell(column.value(row))).join(' | ')} |`),
    '',
  ]

  await writeFile(reportPath, `${lines.join('\n')}`)
  return blockers
}

export const normalizeGeneratedAt = (text) => text.replace(/^- Generated: .+$/m, '- Generated: [generated]')

export const writeReportIfChanged = async (reportPath, report) => {
  if (existsSync(reportPath)) {
    const current = await readFile(reportPath, 'utf8')
    if (normalizeGeneratedAt(current) === normalizeGeneratedAt(report)) return
  }
  await writeFile(reportPath, report)
}

export const resolvedEnv = () => ({
  supabaseUrl: envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL'),
  dbUrl: envValue('SUPABASE_DB_URL', 'E2E_SUPABASE_DB_URL'),
  serviceRoleKey: envValue(
    'E2E_PANCAKE_SUPABASE_SECRET_KEY',
    'PANCAKE_SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
  ),
  anonKey: envValue(
    'E2E_SUPABASE_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  ),
  apiBaseUrl: envValue('E2E_API_BASE_URL', 'EXPO_PUBLIC_API_URL') ??
    edgeApiUrl(envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL')),
  frontendUrl: envValue('E2E_FRONTEND_URL') ?? 'http://127.0.0.1:8081',
  e2eAdminSecret: envValue('E2E_ADMIN_SECRET'),
  backendTicksEnabled: envValue('E2E_ENABLE_EDGE_TICKS', 'E2E_ENABLE_BACKEND_TICKS') === '1',
})

const edgeApiUrl = (supabaseUrl) => {
  if (!supabaseUrl) return undefined
  try {
    return new URL('/functions/v1/api', supabaseUrl.endsWith('/') ? supabaseUrl : `${supabaseUrl}/`).toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export const isProductionSupabaseUrl = (value) => {
  if (!value) return false
  const productionRef = envValue('E2E_PRODUCTION_SUPABASE_REF', 'PRODUCTION_SUPABASE_REF') ?? DEFAULT_PRODUCTION_SUPABASE_REF
  try {
    const url = new URL(value)
    return url.hostname === `${productionRef}.supabase.co` || url.hostname.startsWith(`${productionRef}.`)
  } catch {
    return value.includes(productionRef)
  }
}

export const requireEnv = (env, keys) => {
  const missing = keys.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required E2E environment: ${missing.join(', ')}`)
  }
  if (
    keys.includes('serviceRoleKey') &&
    isProductionSupabaseUrl(env.supabaseUrl) &&
    process.env.E2E_ALLOW_PROD_WRITES !== '1'
  ) {
    throw new Error(
      'Refusing to run service-role E2E against the production Supabase project. ' +
        'Use a local/test project, or set E2E_ALLOW_PROD_WRITES=1 only for an intentional, cleanup-backed production run.',
    )
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
