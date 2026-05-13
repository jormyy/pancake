import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { describeEndpoint, envValue, loadEnvFile } from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/production-readiness-report.md')

loadEnvFile(path.join(ROOT, '.env'))
loadEnvFile(path.join(ROOT, 'backend/.env'))

const commandText = (command, args) => [command, ...args].join(' ')

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: ROOT,
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

const statusFrom = (condition, blocked = 'BLOCKED') => (condition ? 'PASS' : blocked)

const cleanMessage = (text) => text
  .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
  .replaceAll(/\bsb_secret_[A-Za-z0-9_-]+\b/g, '[redacted-secret-key]')
  .replaceAll(/\bsb_publishable_[A-Za-z0-9_-]+\b/g, '[redacted-publishable-key]')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(0, 6)
  .join(' / ')

const readProjectRef = async () => {
  const refPath = path.join(ROOT, 'supabase/.temp/project-ref')
  if (!existsSync(refPath)) return null
  const value = (await readFile(refPath, 'utf8')).trim()
  return value ? '[linked-project-ref-present]' : null
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const hasSecretName = (secretsOutput, name) => {
  const parsed = parseJson(secretsOutput)
  if (Array.isArray(parsed)) return parsed.some((row) => row?.name === name)
  return new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(secretsOutput)
}

const hasKeyType = (rows, type) => Array.isArray(rows) && rows.some((row) => row?.type === type)

const legacyKeyNames = (rows) => {
  if (!Array.isArray(rows)) return null
  return rows
    .filter((row) => row?.type === 'legacy')
    .map((row) => row.name ?? row.id ?? 'legacy')
    .sort()
}

const startsWith = (value, prefix) => typeof value === 'string' && value.startsWith(prefix)

const main = async () => {
  const rows = []

  const supabaseVersion = run('supabase', ['--version'])
  rows.push({
    requirement: 'Supabase CLI available',
    status: statusFrom(supabaseVersion.status === 0),
    evidence: supabaseVersion.status === 0 ? cleanMessage(supabaseVersion.stdout) : cleanMessage(supabaseVersion.stderr || String(supabaseVersion.error)),
  })

  const projectRef = await readProjectRef()
  rows.push({
    requirement: 'Supabase project linked',
    status: statusFrom(Boolean(projectRef)),
    evidence: projectRef ?? 'supabase/.temp/project-ref is missing',
  })

  const secrets = run('supabase', ['secrets', 'list', '-o', 'json'])
  const hasSecretKeys = secrets.status === 0 && hasSecretName(secrets.stdout, 'SUPABASE_SECRET_KEYS')
  rows.push({
    requirement: 'Hosted Edge secret-key dictionary present',
    status: statusFrom(hasSecretKeys),
    evidence: hasSecretKeys
      ? 'Supabase Edge secrets include SUPABASE_SECRET_KEYS.'
      : `Could not verify SUPABASE_SECRET_KEYS: ${cleanMessage(secrets.stderr || secrets.stdout || String(secrets.error))}`,
  })

  const apiKeys = run('supabase', ['projects', 'api-keys', '-o', 'json'])
  const apiKeyRows = parseJson(apiKeys.stdout)
  const hasPublishableKey = hasKeyType(apiKeyRows, 'publishable')
  const hasSecretKey = hasKeyType(apiKeyRows, 'secret')
  const legacyKeys = legacyKeyNames(apiKeyRows)
  rows.push({
    requirement: 'Supabase API-key metadata readable',
    status: statusFrom(apiKeys.status === 0),
    evidence: apiKeys.status === 0
      ? `Management API returned ${Array.isArray(apiKeyRows) ? apiKeyRows.length : 'unknown'} API-key metadata row(s); values intentionally not printed.`
      : cleanMessage(apiKeys.stderr || apiKeys.stdout || String(apiKeys.error)),
  })

  rows.push({
    requirement: 'Supabase modern API keys available',
    status: statusFrom(hasPublishableKey && hasSecretKey),
    evidence: hasPublishableKey && hasSecretKey
      ? 'Management API metadata includes publishable and secret API-key records.'
      : 'Missing publishable or secret API-key metadata; do not disable legacy JWT keys yet.',
  })

  const publicKey = envValue(
    'E2E_SUPABASE_PUBLISHABLE_KEY',
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'E2E_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  )
  rows.push({
    requirement: 'Local frontend Supabase key is non-legacy',
    status: statusFrom(startsWith(publicKey, 'sb_publishable_')),
    evidence: startsWith(publicKey, 'sb_publishable_')
      ? 'Frontend/E2E env resolves to an sb_publishable_ key.'
      : 'Set EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY or E2E_SUPABASE_PUBLISHABLE_KEY to a Supabase publishable key before disabling legacy anon JWTs.',
  })

  const adminKey = envValue(
    'E2E_PANCAKE_SUPABASE_SECRET_KEY',
    'PANCAKE_SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  )
  rows.push({
    requirement: 'Local backend Supabase admin key is non-legacy',
    status: statusFrom(startsWith(adminKey, 'sb_secret_')),
    evidence: startsWith(adminKey, 'sb_secret_')
      ? 'Backend/E2E env resolves to an sb_secret_ key.'
      : 'Set PANCAKE_SUPABASE_SECRET_KEY, SUPABASE_SECRET_KEY, or E2E_* equivalent to a Supabase secret key before disabling legacy service-role JWTs.',
  })

  const dbPasswordPresent = Boolean(envValue('SUPABASE_DB_PASSWORD'))
  rows.push({
    requirement: 'Linked Supabase DB password available',
    status: statusFrom(dbPasswordPresent),
    evidence: dbPasswordPresent ? 'SUPABASE_DB_PASSWORD is present in the process environment.' : 'SUPABASE_DB_PASSWORD is not set.',
  })

  const dbQuery = run('supabase', ['db', 'query', '--linked', 'select now();'], { timeout: 45000 })
  rows.push({
    requirement: 'Linked Supabase DB query access',
    status: statusFrom(dbQuery.status === 0),
    evidence: dbQuery.status === 0
      ? 'supabase db query --linked completed.'
      : cleanMessage(dbQuery.stderr || dbQuery.stdout || String(dbQuery.error)),
  })

  const dbPush = run('supabase', ['db', 'push', '--dry-run'], { timeout: 45000 })
  rows.push({
    requirement: 'Linked Supabase migration dry-run',
    status: statusFrom(dbPush.status === 0),
    evidence: dbPush.status === 0
      ? 'supabase db push --dry-run completed.'
      : cleanMessage(dbPush.stderr || dbPush.stdout || String(dbPush.error)),
  })

  const apiUrl = envValue('E2E_REMOTE_API_URL', 'EXPO_PUBLIC_API_URL')
  let remoteHealth = null
  if (apiUrl) {
    const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`
    const health = run('curl', ['-fsS', '--max-time', '15', healthUrl])
    remoteHealth = health.status === 0 ? parseJson(health.stdout) : null
    rows.push({
      requirement: 'Hosted Fastify health endpoint reachable',
      status: statusFrom(health.status === 0),
      evidence: health.status === 0 ? `${describeEndpoint(healthUrl)} returned healthy JSON.` : cleanMessage(health.stderr || health.stdout || String(health.error)),
    })
  } else {
    rows.push({
      requirement: 'Hosted Fastify health endpoint reachable',
      status: 'BLOCKED',
      evidence: 'E2E_REMOTE_API_URL or EXPO_PUBLIC_API_URL is not configured.',
    })
  }

  const hostedFastifyModernKey = remoteHealth?.supabaseAdminKeyMode === 'modern-secret'
  const hostedFastifyManualVerified = envValue('PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED') === '1'
  rows.push({
    requirement: 'Hosted Fastify secret-key env verified',
    status: statusFrom(hostedFastifyModernKey || hostedFastifyManualVerified),
    evidence: hostedFastifyModernKey
      ? 'Hosted /health reports supabaseAdminKeyMode=modern-secret.'
      : hostedFastifyManualVerified
        ? 'Manual deployment/env verification flag is set.'
        : remoteHealth?.supabaseAdminKeyMode === 'legacy-service-role'
          ? 'Hosted /health reports legacy-service-role; set PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY on the host before disabling legacy keys.'
        : 'Deploy a backend that exposes /health.supabaseAdminKeyMode, or set PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED=1 only after the host has PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY configured.',
  })

  const railwayAuth = run('npx', ['--yes', '@railway/cli', 'whoami'], { timeout: 30000 })
  rows.push({
    requirement: 'Railway CLI authenticated',
    status: statusFrom(railwayAuth.status === 0),
    evidence: railwayAuth.status === 0
      ? 'Railway CLI is authenticated; hosted Fastify env can be inspected with Railway project access.'
      : cleanMessage(railwayAuth.stderr || railwayAuth.stdout || String(railwayAuth.error)),
  })

  const legacyKeysDisabled = Array.isArray(legacyKeys) && legacyKeys.length === 0
  const legacyKeysManualVerified = envValue('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED') === '1'
  rows.push({
    requirement: 'Remote legacy Supabase JWT keys disabled/revoked',
    status: statusFrom(legacyKeysDisabled || legacyKeysManualVerified),
    evidence: legacyKeysDisabled
      ? 'Supabase API-key metadata no longer includes legacy JWT key records.'
      : legacyKeysManualVerified
        ? 'Manual hosted-project legacy-key disable/revocation verification flag is set.'
        : Array.isArray(legacyKeys)
          ? `Supabase API-key metadata still includes legacy key record(s): ${legacyKeys.join(', ')}.`
          : 'Could not parse Supabase API-key metadata; set PANCAKE_LEGACY_SUPABASE_JWT_ROTATED=1 only after independent hosted-project legacy-key disable/revocation verification.',
  })

  const blockers = rows.filter((row) => row.status !== 'PASS')
  const lines = [
    '# Production Readiness Blocker Check',
    '',
    `- Status: ${blockers.length === 0 ? 'PASS' : 'BLOCKED'}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '| Requirement | Status | Evidence |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.requirement} | ${row.status} | ${row.evidence.replaceAll('\n', '<br>')} |`),
    '',
    '## Notes',
    '',
    '- This check intentionally avoids printing secret values.',
    '- Manual flags are only accepted for host/dashboard operations that are not readable through local repo or Supabase CLI state.',
    '- Before disabling legacy Supabase JWT keys, deploy hosted Fastify with `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY` and verify `/health` reports `supabaseAdminKeyMode=modern-secret`.',
    '- To disable legacy Supabase JWT keys after hosted Fastify is verified, use the Supabase Management API endpoint: `PUT https://api.supabase.com/v1/projects/{ref}/api-keys/legacy?enabled=false`.',
    '- To unblock linked Supabase migrations, provide `SUPABASE_DB_PASSWORD` or restore Supabase temporary login-role creation, then rerun `supabase db query --linked "select now();"` and `supabase db push --dry-run`.',
    '- To unblock hosted Fastify verification from this machine, authenticate Railway with `railway login` or provide a valid Railway token/session for `npx --yes @railway/cli whoami`.',
    '- No GitHub-hosted Railway deploy fallback is configured: the repository has only the `Tests` workflow, and repository/environment secrets and variables are empty.',
  ]

  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
  console.log(`${blockers.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)

  if (blockers.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
