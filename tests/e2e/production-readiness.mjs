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
  rows.push({
    requirement: 'Supabase API-key metadata readable',
    status: statusFrom(apiKeys.status === 0),
    evidence: apiKeys.status === 0
      ? `Management API returned ${Array.isArray(apiKeyRows) ? apiKeyRows.length : 'unknown'} API-key metadata row(s); values intentionally not printed.`
      : cleanMessage(apiKeys.stderr || apiKeys.stdout || String(apiKeys.error)),
  })

  const dbPasswordPresent = Boolean(envValue('SUPABASE_DB_PASSWORD'))
  rows.push({
    requirement: 'Linked Supabase DB password available',
    status: statusFrom(dbPasswordPresent),
    evidence: dbPasswordPresent ? 'SUPABASE_DB_PASSWORD is present in the process environment.' : 'SUPABASE_DB_PASSWORD is not set.',
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
  if (apiUrl) {
    const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`
    const health = run('curl', ['-fsS', '--max-time', '15', healthUrl])
    rows.push({
      requirement: 'Hosted Fastify health endpoint reachable',
      status: statusFrom(health.status === 0),
      evidence: health.status === 0 ? `${describeEndpoint(healthUrl)}/health returned healthy JSON.` : cleanMessage(health.stderr || health.stdout || String(health.error)),
    })
  } else {
    rows.push({
      requirement: 'Hosted Fastify health endpoint reachable',
      status: 'BLOCKED',
      evidence: 'E2E_REMOTE_API_URL or EXPO_PUBLIC_API_URL is not configured.',
    })
  }

  rows.push({
    requirement: 'Hosted Fastify secret-key env verified',
    status: statusFrom(envValue('PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED') === '1'),
    evidence: envValue('PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED') === '1'
      ? 'Manual deployment/env verification flag is set.'
      : 'Set PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED=1 only after the host has PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY configured.',
  })

  rows.push({
    requirement: 'Legacy Supabase JWT/service-role rotated',
    status: statusFrom(envValue('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED') === '1'),
    evidence: envValue('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED') === '1'
      ? 'Manual rotation verification flag is set.'
      : 'Set PANCAKE_LEGACY_SUPABASE_JWT_ROTATED=1 only after Supabase Dashboard key/JWT rotation and old credential revocation are complete.',
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
