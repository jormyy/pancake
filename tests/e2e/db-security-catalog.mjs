import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  cleanMessage,
  envValue,
  localSupabaseStatus,
  querySupabaseDb,
  writeMarkdownReport,
} from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/db-security-catalog-report.md')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const SUPABASE_CONFIG = path.join(ROOT, 'supabase/config.toml')

const args = new Set(process.argv.slice(2))
const targets = args.has('--both')
  ? ['local', 'linked']
  : [args.has('--linked') ? 'linked' : 'local']

const latestMigrationVersion = () => readdirSync(MIGRATIONS)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort()
  .at(-1)
  ?.match(/^(\d+)_/)?.[1]

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

const latestVersion = latestMigrationVersion()
if (!latestVersion) throw new Error('Could not resolve latest Supabase migration version')

const configContents = readFileSync(SUPABASE_CONFIG, 'utf8')
const passwordLengthMatch = configContents.match(/^\s*minimum_password_length\s*=\s*(\d+)\s*$/m)
const minimumPasswordLength = passwordLengthMatch ? Number(passwordLengthMatch[1]) : 0

const catalogSql = `
WITH expected AS (
  SELECT '${latestVersion}'::text AS latest_version
),
migration AS (
  SELECT EXISTS (
    SELECT 1
      FROM supabase_migrations.schema_migrations sm, expected e
     WHERE sm.version = e.latest_version
  ) AS latest_migration_applied
),
cron_wrapper AS (
  SELECT
    has_function_privilege('anon', 'public.invoke_edge_function_at_et_time(text,int,int)', 'EXECUTE') AS cron_anon_exec,
    has_function_privilege('authenticated', 'public.invoke_edge_function_at_et_time(text,int,int)', 'EXECUTE') AS cron_auth_exec,
    has_function_privilege('service_role', 'public.invoke_edge_function_at_et_time(text,int,int)', 'EXECUTE') AS cron_service_exec
),
waiver_policy AS (
  SELECT
    count(*) FILTER (WHERE policyname = 'waiver_wire_log_select_visible_league_rows') AS waiver_policy_count,
    coalesce(string_agg(qual, ' | ' ORDER BY policyname), '') AS waiver_policy_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'waiver_wire_log'
),
drop_player AS (
  SELECT pg_get_functiondef('public.drop_player_atomic(uuid)'::regprocedure) AS function_def
),
edge_invoker AS (
  SELECT pg_get_functiondef('public.invoke_edge_function(text,jsonb)'::regprocedure) AS function_def
),
rookie_activation AS (
  SELECT pg_get_functiondef('public.activate_rookie_draft_league_atomic(uuid)'::regprocedure) AS function_def
),
service_role_reads AS (
  SELECT count(*) FILTER (
    WHERE NOT has_table_privilege(
      'service_role',
      format('%I.%I', n.nspname, c.relname),
      'SELECT'
    )
  ) AS missing_read_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT
  expected.latest_version,
  migration.latest_migration_applied,
  cron_wrapper.cron_anon_exec,
  cron_wrapper.cron_auth_exec,
  cron_wrapper.cron_service_exec,
  waiver_policy.waiver_policy_count,
  waiver_policy.waiver_policy_qual,
  waiver_policy.waiver_policy_qual ILIKE '%cleared_at IS NOT NULL%' AS waiver_policy_allows_cleared,
  waiver_policy.waiver_policy_qual ILIKE '%clears_at > now()%' AS waiver_policy_allows_future,
  drop_player.function_def ILIKE '%AND NOT EXISTS%' AS drop_player_has_started_game_guard,
  drop_player.function_def ILIKE '%InProgress%' AS drop_player_checks_inprogress,
  drop_player.function_def ILIKE '%Final%' AS drop_player_checks_final,
  drop_player.function_def ILIKE '%started_at IS NOT NULL%' AS drop_player_checks_started_at,
  edge_invoker.function_def ILIKE '%app.edge_internal_token%' AS edge_invoker_uses_internal_token,
  edge_invoker.function_def ILIKE '%vault.decrypted_secrets%' AS edge_invoker_uses_vault_token,
  edge_invoker.function_def ILIKE '%pancake_edge_internal_token%' AS edge_invoker_uses_named_vault_token,
  edge_invoker.function_def ILIKE '%x-internal-function-token%' AS edge_invoker_sets_internal_header,
  edge_invoker.function_def NOT ILIKE '%app.service_role_key%' AS edge_invoker_drops_service_role_key,
  edge_invoker.function_def NOT ILIKE '%Authorization%' AS edge_invoker_drops_authorization_header,
  rookie_activation.function_def ILIKE '%private.is_commissioner(v_draft.league_id)%' AS rookie_activation_checks_commissioner,
  service_role_reads.missing_read_count AS service_role_missing_read_count
FROM expected, migration, cron_wrapper, waiver_policy, drop_player, edge_invoker, rookie_activation, service_role_reads;
`

const rows = []
const addRow = (target, requirement, status, evidence) => rows.push({ target, requirement, status, evidence })

addRow(
  'config',
  'Supabase Auth minimum password length matches app policy',
  minimumPasswordLength >= 8 ? 'PASS' : 'BLOCKED',
  `minimum_password_length=${minimumPasswordLength}; app signup requires at least 8 characters.`,
)

for (const target of targets) {
  try {
    const [catalog] = queryDb(target, 'security catalog', catalogSql)
    const latestApplied = catalog?.latest_migration_applied === true
    const cronLocked = catalog?.cron_anon_exec === false &&
      catalog?.cron_auth_exec === false &&
      catalog?.cron_service_exec === true
    const waiverPolicySafe = Number(catalog?.waiver_policy_count ?? 0) === 1 &&
      catalog?.waiver_policy_allows_cleared === true &&
      catalog?.waiver_policy_allows_future === true
    const dropPlayerGuarded = catalog?.drop_player_has_started_game_guard === true &&
      catalog?.drop_player_checks_inprogress === true &&
      catalog?.drop_player_checks_final === true &&
      catalog?.drop_player_checks_started_at === true
    const edgeInvokerHardened = catalog?.edge_invoker_uses_internal_token === true &&
      catalog?.edge_invoker_uses_vault_token === true &&
      catalog?.edge_invoker_uses_named_vault_token === true &&
      catalog?.edge_invoker_sets_internal_header === true &&
      catalog?.edge_invoker_drops_service_role_key === true &&
      catalog?.edge_invoker_drops_authorization_header === true
    const rookieActivationGuarded = catalog?.rookie_activation_checks_commissioner === true
    const serviceRoleReadsPublicRelations = Number(catalog?.service_role_missing_read_count ?? 0) === 0

    addRow(
      target,
      'Latest migration applied',
      latestApplied ? 'PASS' : 'BLOCKED',
      `latest=${catalog?.latest_version}; applied=${catalog?.latest_migration_applied}.`,
    )
    addRow(
      target,
      'ET cron wrapper is service-role-only',
      cronLocked ? 'PASS' : 'BLOCKED',
      `anon=${catalog?.cron_anon_exec}; authenticated=${catalog?.cron_auth_exec}; service_role=${catalog?.cron_service_exec}.`,
    )
    addRow(
      target,
      'Waiver-wire privacy policy hides expired uncleared rows',
      waiverPolicySafe ? 'PASS' : 'BLOCKED',
      `policy_count=${catalog?.waiver_policy_count}; qual=${catalog?.waiver_policy_qual}.`,
    )
    addRow(
      target,
      'Drop-player RPC preserves started-game lineup rows',
      dropPlayerGuarded ? 'PASS' : 'BLOCKED',
      `has_guard=${catalog?.drop_player_has_started_game_guard}; checks_inprogress=${catalog?.drop_player_checks_inprogress}; checks_final=${catalog?.drop_player_checks_final}; checks_started_at=${catalog?.drop_player_checks_started_at}.`,
    )
    addRow(
      target,
      'Cron Edge invoker uses only the dedicated internal token header',
      edgeInvokerHardened ? 'PASS' : 'BLOCKED',
      `uses_internal_token=${catalog?.edge_invoker_uses_internal_token}; uses_vault=${catalog?.edge_invoker_uses_vault_token}; uses_named_vault=${catalog?.edge_invoker_uses_named_vault_token}; sets_header=${catalog?.edge_invoker_sets_internal_header}; drops_service_role_key=${catalog?.edge_invoker_drops_service_role_key}; drops_authorization=${catalog?.edge_invoker_drops_authorization_header}.`,
    )
    addRow(
      target,
      'Rookie activation RPC requires commissioner authority',
      rookieActivationGuarded ? 'PASS' : 'BLOCKED',
      `checks_commissioner=${catalog?.rookie_activation_checks_commissioner}.`,
    )
    addRow(
      target,
      'Trusted service_role can read public relations',
      serviceRoleReadsPublicRelations ? 'PASS' : 'BLOCKED',
      `missing_read_count=${catalog?.service_role_missing_read_count}.`,
    )
  } catch (error) {
    addRow(target, 'DB security catalog query', 'BLOCKED', error instanceof Error ? error.message : String(error))
  }
}

for (const target of targets) {
  try {
    const evidence = await verifyWeakSignupRejected(target)
    addRow(target, 'Active Auth rejects passwords shorter than app policy', 'PASS', evidence)
  } catch (error) {
    addRow(
      target,
      'Active Auth rejects passwords shorter than app policy',
      'BLOCKED',
      error instanceof Error ? error.message : String(error),
    )
  }
}

const blockers = rows.filter((row) => row.status !== 'PASS')
await writeMarkdownReport({
  reportPath: REPORT_PATH,
  title: 'DB Security Catalog',
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
