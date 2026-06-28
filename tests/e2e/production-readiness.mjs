import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import {
  cleanMessage,
  describeEndpoint,
  envValue,
  loadEnvFile,
  runCommand,
  statusFrom,
  writeReportIfChanged,
} from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/production-readiness-report.md')

loadEnvFile(path.join(ROOT, '.env'))

const run = runCommand

const readLinkedProjectRef = async () => {
  const refPath = path.join(ROOT, 'supabase/.temp/project-ref')
  if (!existsSync(refPath)) return null
  const value = (await readFile(refPath, 'utf8')).trim()
  return value || null
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

const decodeSupabaseKeychainValue = (value) => {
  if (!value.startsWith('go-keyring-base64:')) return value
  return Buffer.from(value.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
}

const supabaseAccessToken = () => {
  const envToken = envValue('SUPABASE_ACCESS_TOKEN')
  if (envToken) return envToken
  if (process.platform !== 'darwin') return null

  try {
    const raw = execFileSync('security', [
      'find-generic-password',
      '-s',
      'Supabase CLI',
      '-a',
      'supabase',
      '-w',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return raw ? decodeSupabaseKeychainValue(raw) : null
  } catch {
    return null
  }
}

const legacyApiKeysEnabled = async (projectRef) => {
  const token = supabaseAccessToken()
  if (!projectRef || !token) return { ok: false, enabled: null, evidence: 'Supabase Management API access token is unavailable.' }

  try {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/api-keys/legacy`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )
    const text = await response.text()
    const parsed = parseJson(text)
    if (!response.ok) {
      return {
        ok: false,
        enabled: null,
        evidence: `Management API legacy-key state probe failed with status ${response.status}; ${cleanMessage(text, { maxLines: 4 })}`,
      }
    }
    if (typeof parsed?.enabled !== 'boolean') {
      return {
        ok: false,
        enabled: null,
        evidence: `Management API legacy-key state probe returned an unexpected payload: ${cleanMessage(text, { maxLines: 4 })}`,
      }
    }
    return {
      ok: true,
      enabled: parsed.enabled,
      evidence: parsed.enabled
        ? 'Management API reports legacy Supabase JWT keys are still enabled.'
        : 'Management API reports legacy Supabase JWT keys are disabled.',
    }
  } catch (error) {
    return {
      ok: false,
      enabled: null,
      evidence: `Management API legacy-key state probe threw: ${cleanMessage(error instanceof Error ? error.message : String(error), { maxLines: 4 })}`,
    }
  }
}

const canQueryWithSupabaseKey = async (url, key) => {
  if (!url || !key) return { ok: false, evidence: 'Supabase URL or admin key is not configured.' }
  try {
    const client = createClient(url, key, { auth: { persistSession: false } })
    const { error, status } = await client
      .from('nba_games')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error || (status && status >= 400)) {
      return {
        ok: false,
        evidence: `Admin key PostgREST probe failed with status ${status ?? 'unknown'}; values intentionally not printed.`,
      }
    }
    return { ok: true, evidence: 'Admin key can query PostgREST through Supabase client.' }
  } catch (error) {
    return {
      ok: false,
        evidence: `Admin key PostgREST probe threw: ${cleanMessage(error instanceof Error ? error.message : String(error), { maxLines: 6 })}`,
    }
  }
}

const main = async () => {
  const rows = []

  const supabaseVersion = run('supabase', ['--version'])
  rows.push({
    requirement: 'Supabase CLI available',
    status: statusFrom(supabaseVersion.status === 0),
    evidence: supabaseVersion.status === 0 ? cleanMessage(supabaseVersion.stdout, { maxLines: 6 }) : cleanMessage(supabaseVersion.stderr || String(supabaseVersion.error), { maxLines: 6 }),
  })

  const projectRef = await readLinkedProjectRef()
  rows.push({
    requirement: 'Supabase project linked',
    status: statusFrom(Boolean(projectRef)),
    evidence: projectRef ? '[linked-project-ref-present]' : 'supabase/.temp/project-ref is missing',
  })

  const secrets = run('supabase', ['secrets', 'list', '-o', 'json'])
  const hasSecretKeys = secrets.status === 0 && hasSecretName(secrets.stdout, 'SUPABASE_SECRET_KEYS')
  const hasInternalToken = secrets.status === 0 &&
    (hasSecretName(secrets.stdout, 'PANCAKE_EDGE_INTERNAL_TOKEN') ||
      hasSecretName(secrets.stdout, 'EDGE_FUNCTION_INTERNAL_TOKEN'))
  rows.push({
    requirement: 'Hosted Edge secret-key dictionary present',
    status: statusFrom(hasSecretKeys),
    evidence: hasSecretKeys
      ? 'Supabase Edge secrets include SUPABASE_SECRET_KEYS.'
      : `Could not verify SUPABASE_SECRET_KEYS: ${cleanMessage(secrets.stderr || secrets.stdout || String(secrets.error), { maxLines: 6 })}`,
  })
  rows.push({
    requirement: 'Hosted Edge internal token present',
    status: statusFrom(hasInternalToken),
    evidence: hasInternalToken
      ? 'Supabase Edge secrets include PANCAKE_EDGE_INTERNAL_TOKEN or EDGE_FUNCTION_INTERNAL_TOKEN.'
      : `Could not verify hosted Edge internal token: ${cleanMessage(secrets.stderr || secrets.stdout || String(secrets.error), { maxLines: 6 })}`,
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
      : cleanMessage(apiKeys.stderr || apiKeys.stdout || String(apiKeys.error), { maxLines: 6 }),
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
  )
  rows.push({
    requirement: 'Local frontend Supabase key is non-legacy',
    status: statusFrom(startsWith(publicKey, 'sb_publishable_')),
    evidence: startsWith(publicKey, 'sb_publishable_')
      ? 'Frontend/E2E env resolves to an sb_publishable_ key.'
      : 'Set EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY or E2E_SUPABASE_PUBLISHABLE_KEY to a Supabase publishable key.',
  })

  const adminKey = envValue(
    'E2E_PANCAKE_SUPABASE_SECRET_KEY',
    'PANCAKE_SUPABASE_SECRET_KEY',
    'E2E_SUPABASE_SECRET_KEY',
    'SUPABASE_SECRET_KEY',
  )
  rows.push({
    requirement: 'Local backend Supabase admin key is non-legacy',
    status: statusFrom(startsWith(adminKey, 'sb_secret_')),
    evidence: startsWith(adminKey, 'sb_secret_')
      ? 'Backend/E2E env resolves to an sb_secret_ key.'
      : 'Set PANCAKE_SUPABASE_SECRET_KEY, SUPABASE_SECRET_KEY, or E2E_* equivalent to a Supabase secret key before disabling legacy service-role JWTs.',
  })

  const supabaseUrl = envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL')
  const adminKeyProbe = await canQueryWithSupabaseKey(supabaseUrl, adminKey)
  rows.push({
    requirement: 'Local backend Supabase admin key is usable',
    status: statusFrom(adminKeyProbe.ok),
    evidence: adminKeyProbe.evidence,
  })

  const dbQuery = run('supabase', ['db', 'query', '--linked', 'select now();'], { timeout: 45000 })
  rows.push({
    requirement: 'Linked Supabase DB query access',
    status: statusFrom(dbQuery.status === 0),
    evidence: dbQuery.status === 0
      ? 'supabase db query --linked completed.'
      : cleanMessage(dbQuery.stderr || dbQuery.stdout || String(dbQuery.error), { maxLines: 6 }),
  })

  const dbPush = run('supabase', ['db', 'push', '--dry-run'], { timeout: 45000 })
  rows.push({
    requirement: 'Linked Supabase migration dry-run',
    status: statusFrom(dbPush.status === 0),
    evidence: dbPush.status === 0
      ? 'supabase db push --dry-run completed.'
      : cleanMessage(dbPush.stderr || dbPush.stdout || String(dbPush.error), { maxLines: 6 }),
  })

  const dbPasswordPresent = Boolean(envValue('SUPABASE_DB_PASSWORD'))
  const linkedDbAccessVerified = dbPasswordPresent || (dbQuery.status === 0 && dbPush.status === 0)
  rows.push({
    requirement: 'Linked Supabase DB credential path verified',
    status: statusFrom(linkedDbAccessVerified),
    evidence: dbPasswordPresent
      ? 'SUPABASE_DB_PASSWORD is present in the process environment.'
      : linkedDbAccessVerified
        ? 'Supabase CLI linked DB query and migration dry-run completed via the temporary login role without SUPABASE_DB_PASSWORD.'
        : 'Set SUPABASE_DB_PASSWORD or restore Supabase temporary login-role creation, then rerun linked DB query and migration dry-run checks.',
  })

  const apiUrl = envValue('E2E_REMOTE_API_URL', 'EXPO_PUBLIC_API_URL')
  let remoteHealth = null
  if (apiUrl) {
    const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`
    const health = run('curl', ['-fsS', '--max-time', '15', healthUrl])
    remoteHealth = health.status === 0 ? parseJson(health.stdout) : null
    const edgeApiHealthy = health.status === 0 &&
      remoteHealth?.ok === true &&
      remoteHealth?.service === 'pancake-supabase-api' &&
      remoteHealth?.runtime === 'supabase-edge'
    rows.push({
      requirement: 'Hosted Supabase Edge API health endpoint reachable',
      status: statusFrom(edgeApiHealthy),
      evidence: edgeApiHealthy
        ? `${describeEndpoint(healthUrl)} returned Supabase Edge API health JSON.`
        : health.status === 0
          ? `Unexpected health payload: ${cleanMessage(health.stdout, { maxLines: 6 })}`
          : cleanMessage(health.stderr || health.stdout || String(health.error), { maxLines: 6 }),
    })
  } else {
    rows.push({
      requirement: 'Hosted Supabase Edge API health endpoint reachable',
      status: 'BLOCKED',
      evidence: 'E2E_REMOTE_API_URL or EXPO_PUBLIC_API_URL is not configured.',
    })
  }

  const legacyState = await legacyApiKeysEnabled(projectRef)
  const legacyKeysDisabled = Array.isArray(legacyKeys) && legacyKeys.length === 0
  const legacyKeysDisabledByState = legacyState.ok && legacyState.enabled === false
  const legacyKeysManualVerified = envValue('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED') === '1'
  rows.push({
    requirement: 'Remote legacy Supabase JWT keys disabled/revoked',
    status: statusFrom(legacyKeysDisabledByState || legacyKeysDisabled || legacyKeysManualVerified),
    evidence: legacyKeysDisabledByState
      ? legacyState.evidence
      : legacyKeysDisabled
        ? 'Supabase API-key metadata no longer includes legacy JWT key records.'
        : legacyKeysManualVerified
        ? 'Manual hosted-project legacy-key disable/revocation verification flag is set.'
        : legacyState.ok
          ? legacyState.evidence
          : Array.isArray(legacyKeys)
            ? `Supabase API-key metadata still includes legacy key record(s): ${legacyKeys.join(', ')}; ${legacyState.evidence}`
            : `Could not parse Supabase API-key metadata; ${legacyState.evidence} Set PANCAKE_LEGACY_SUPABASE_JWT_ROTATED=1 only after independent hosted-project legacy-key disable/revocation verification.`,
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
    '- Manual flags are only accepted for host/dashboard operations that are not readable through local repo, Supabase CLI state, or the Supabase Management API.',
    '- Before disabling legacy Supabase JWT keys, deploy the Supabase `api`, `process-trades`, and `close-expired-nominations` Edge Functions and verify `/functions/v1/api/health`.',
    '- To disable legacy Supabase JWT keys after Supabase Edge API verification, use the Supabase Management API endpoint: `PUT https://api.supabase.com/v1/projects/{ref}/api-keys/legacy?enabled=false`.',
    '- If linked Supabase DB access fails, provide `SUPABASE_DB_PASSWORD` or restore Supabase temporary login-role creation, then rerun `supabase db query --linked "select now();"` and `supabase db push --dry-run`.',
  ]

  await writeReportIfChanged(REPORT_PATH, `${lines.join('\n')}\n`)
  console.log(`${blockers.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)

  if (blockers.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
