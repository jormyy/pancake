import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { cleanMessage, envValue, localSupabaseStatus, querySupabaseDb, writeMarkdownReport } from './env.mjs'
import { parseCatalogOptions, validateCatalogTarget, validateSecurityCatalog } from './db-security-catalog-contract.mjs'

const ROOT = process.cwd()
const options = parseCatalogOptions(process.argv.slice(2))
const REPORT_PATH = path.join(ROOT, options.catalogOnly
  ? 'tests/db-security-catalog-readonly-report.md' : 'tests/db-security-catalog-report.md')
const queryDb = querySupabaseDb

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`

const parseJsonBody = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const optionalString = (value) => typeof value === 'string' ? value : undefined

const authEndpoint = (target) => {
  if (target === 'local') {
    const status = localSupabaseStatus()
    return {
      apiUrl: optionalString(status.API_URL),
      publicKey: optionalString(status.PUBLISHABLE_KEY) ?? optionalString(status.ANON_KEY),
    }
  }

  return {
    apiUrl: envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL'),
    publicKey: envValue(
      'E2E_SUPABASE_PUBLISHABLE_KEY',
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ),
  }
}

const verifyWeakSignupRejected = async (target) => {
  const { apiUrl, publicKey } = authEndpoint(target)
  if (!apiUrl || !publicKey) throw new Error(`${target} Supabase API URL or public key is unavailable`)

  const email = `pancake-weak-password-${target}-${Date.now()}-${process.pid}@example.invalid`
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${publicKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password: 'abc1234' }),
  })
  const bodyText = await res.text().catch(() => '')
  const body = parseJsonBody(bodyText)

  if (res.ok) {
    queryDb(target, 'weak signup cleanup', `DELETE FROM auth.users WHERE email = ${sqlLiteral(email)};`)
    throw new Error(`7-character password signup returned HTTP ${res.status}; probe user was deleted`)
  }

  if (res.status === 422 && body?.error_code === 'weak_password') {
    return `7-character password signup rejected with expected weak_password response.`
  }

  if (res.status >= 500) {
    throw new Error(`Auth signup probe returned HTTP ${res.status}: ${cleanMessage(bodyText)}`)
  }
  throw new Error(`Auth signup rejected for an unexpected reason: HTTP ${res.status}: ${cleanMessage(bodyText)}`)
}

// A leading SQL comment must not look like a CLI option in the positional argument.
const catalogSql = '\n' + readFileSync(new URL('./db-security-catalog.sql', import.meta.url), 'utf8')
const historySql = '\n' + readFileSync(new URL('./release-schema-history.sql', import.meta.url), 'utf8')
const queryCatalog = (target, label, sql) => {
  if (target === 'linked') return queryDb(target, label, sql)
  // The local CLI query uses a prepared statement and rejects BEGIN/SELECT/ROLLBACK.
  // psql preserves the same read-only transaction without changing the linked route.
  const databaseUrl = localSupabaseStatus().DB_URL
  if (typeof databaseUrl !== 'string' || !databaseUrl) throw new Error('Local database URL is missing')
  const url = new URL(databaseUrl)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Catalog local database must use a loopback URL')
  }
  const result = spawnSync('psql', ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
    '--set=ON_ERROR_STOP=1', '--dbname', databaseUrl, '--file', '-'],
  { input: sql, encoding: 'utf8', timeout: 45000, cwd: ROOT, env: process.env })
  if (result.status !== 0) throw new Error(`local ${label}: ${cleanMessage(result.stderr || result.error?.message)}`)
  return [{ snapshot: JSON.parse(result.stdout.trim()) }]
}
const repositoryFiles = readdirSync(path.join(ROOT, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort()
  .map((filename) => ({ filename, sha256: createHash('sha256').update(readFileSync(path.join(ROOT, 'supabase/migrations', filename))).digest('hex') }))
const config = readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8')
const minimumPasswordLength = Number(config.match(/^\s*minimum_password_length\s*=\s*(\d+)\s*$/m)?.[1] ?? 0)
const rows = []
const addRow = (target, requirement, status, evidence) => rows.push({ target, requirement, status, evidence })
const assertTarget = (target) => {
  const refPath = path.join(ROOT, 'supabase/.temp/project-ref')
  validateCatalogTarget({ target, linkedRef: existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : '',
    projectRef: process.env.SUPABASE_PROJECT_REF })
}

addRow('config', 'Supabase Auth minimum password length matches app policy',
  minimumPasswordLength >= 8 ? 'PASS' : 'BLOCKED', `minimum_password_length=${minimumPasswordLength}.`)

for (const target of options.targets) {
  try {
    assertTarget(target)
    const historyRows = queryCatalog(target, 'migration history attestation', historySql)
    assertTarget(target)
    const catalogRows = queryCatalog(target, 'security catalog metadata', catalogSql)
    assertTarget(target)
    if (historyRows.length !== 1 || catalogRows.length !== 1) throw new Error('Expected exactly one history and catalog snapshot')
    const result = validateSecurityCatalog({ phase: options.phase, target, projectRef: process.env.SUPABASE_PROJECT_REF,
      repositoryFiles, history: historyRows[0].snapshot, catalog: catalogRows[0].snapshot })
    addRow(target, 'Exact database phase and security catalog', 'PASS',
      `${result.phase}: ${result.migrationCount} migrations through ${result.migrationVersion}; ` +
      `${result.functions} function fingerprints/signatures/grants, ${result.triggers} enabled roster trigger definitions, ` +
      `${result.policies} waiver policies, ${result.tables} table boundaries, ${result.indexes} valid indexes. ` +
      'The roster trigger and both lineup helpers match the approved guard chain.')
  } catch (error) {
    addRow(target, 'Exact database phase and security catalog', 'BLOCKED', cleanMessage(error instanceof Error ? error.message : String(error)))
    continue
  }
  if (!options.catalogOnly) {
    try {
      assertTarget(target)
      const evidence = await verifyWeakSignupRejected(target)
      addRow(target, 'Active Auth rejects passwords shorter than app policy', 'PASS', evidence)
    } catch (error) {
      addRow(target, 'Active Auth rejects passwords shorter than app policy', 'BLOCKED', cleanMessage(error instanceof Error ? error.message : String(error)))
    }
  }
}

const blockers = rows.filter((row) => row.status !== 'PASS')
await writeMarkdownReport({
  reportPath: REPORT_PATH,
  title: options.catalogOnly ? 'Read-only DB Security Catalog (no signup probe)' : 'DB Security Catalog',
  rows,
  columns: [
    { header: 'Target', value: (row) => row.target },
    { header: 'Requirement', value: (row) => row.requirement },
    { header: 'Status', value: (row) => row.status },
    { header: 'Evidence', value: (row) => row.evidence },
  ],
})
console.log(`${blockers.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)
if (blockers.length > 0) process.exitCode = 1
