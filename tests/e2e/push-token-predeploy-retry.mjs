import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.E2E_SUPABASE_DB_URL
if (!dbUrl) throw new Error('SUPABASE_DB_URL is required')

const hostname = new URL(dbUrl).hostname
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
  throw new Error('Push-token predeploy retry regression only runs against local PostgreSQL')
}

const PREDEPLOY = path.join(ROOT, 'supabase/predeploy')
const DROP_INVALID = path.join(PREDEPLOY, '20260710130000_profiles_push_token_lookup_drop_invalid.sql')
const QUARANTINE_INVALID = path.join(PREDEPLOY, '20260710130000_profiles_push_token_lookup_quarantine_invalid.sql')
const BUILD = path.join(PREDEPLOY, '20260710130000_profiles_push_token_lookup.sql')
const USER_ID = '00000000-0000-0000-0000-000000099998'

function psql(args, { allowFailure = false } = {}) {
  const result = spawnSync('psql', [dbUrl, '--set', 'ON_ERROR_STOP=1', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || 'psql failed')
  }
  return result
}

const execute = (sql, options) => psql(['--command', sql], options)
const executeFile = (filename) => psql(['--file', filename])
const scalar = (sql) => psql(['--tuples-only', '--no-align', '--command', sql]).stdout.trim()

function runPredeploy() {
  executeFile(DROP_INVALID)
  executeFile(QUARANTINE_INVALID)
  executeFile(DROP_INVALID)
  executeFile(BUILD)
}

function indexState() {
  return scalar(`
    SELECT concat_ws('|', index_class.oid, index_state.indisvalid, index_state.indisready,
      pg_catalog.pg_get_indexdef(index_class.oid))
      FROM pg_catalog.pg_class AS index_class
      JOIN pg_catalog.pg_namespace AS index_namespace
        ON index_namespace.oid = index_class.relnamespace
      JOIN pg_catalog.pg_index AS index_state
        ON index_state.indexrelid = index_class.oid
     WHERE index_namespace.nspname = 'public'
       AND index_class.relname = 'profiles_push_token_lookup';
  `).split('|')
}

function fallbackCleanup() {
  const cleanup = [
    'DROP INDEX CONCURRENTLY IF EXISTS public.profiles_push_token_lookup;',
    'DROP INDEX CONCURRENTLY IF EXISTS public.profiles_push_token_lookup_invalid;',
    'DROP FUNCTION IF EXISTS public.predeploy_index_failure(text);',
    `DELETE FROM auth.users WHERE id = '${USER_ID}';`,
  ]
  for (const sql of cleanup) execute(sql, { allowFailure: true })
  executeFile(BUILD)
}

try {
  runPredeploy()
  execute(`
    DELETE FROM auth.users WHERE id = '${USER_ID}';
    INSERT INTO auth.users (
      id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
      '${USER_ID}', 'authenticated', 'authenticated',
      'predeploy-retry@example.test', 'x', now(), '{}'::jsonb,
      '{"username":"predeploy_retry"}'::jsonb, now(), now()
    );
    UPDATE public.profiles
       SET push_token = 'ExponentPushToken[predeploy-retry]'
     WHERE id = '${USER_ID}';
    ALTER INDEX public.profiles_push_token_lookup
      RENAME TO profiles_push_token_lookup_invalid;
    CREATE OR REPLACE FUNCTION public.predeploy_index_failure(text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE AS
    $$ BEGIN RAISE EXCEPTION 'injected concurrent index build failure'; END; $$;
  `)

  const failedBuild = execute(`
    CREATE INDEX CONCURRENTLY profiles_push_token_lookup
      ON public.profiles (public.predeploy_index_failure(push_token))
      WHERE push_token IS NOT NULL;
  `, { allowFailure: true })
  assert.notEqual(failedBuild.status, 0, 'injected concurrent build unexpectedly succeeded')

  const [, failedValid, failedReady] = indexState()
  assert.equal(failedValid, 'f', 'failed concurrent build did not leave an invalid index')
  assert.equal(failedReady, 'f', 'failed concurrent build did not leave a not-ready index')

  runPredeploy()
  const [recoveredOid, recoveredValid, recoveredReady, recoveredDefinition] = indexState()
  assert.equal(recoveredValid, 't', 'predeploy retry did not create a valid index')
  assert.equal(recoveredReady, 't', 'predeploy retry did not create a ready index')
  assert.match(recoveredDefinition, /USING btree \(push_token\) WHERE \(push_token IS NOT NULL\)$/)
  assert.equal(
    scalar("SELECT to_regclass('public.profiles_push_token_lookup_invalid') IS NULL;"),
    't',
    'predeploy retry retained its quarantined invalid index',
  )

  runPredeploy()
  assert.equal(indexState()[0], recoveredOid, 'healthy predeploy retry rebuilt an already-valid index')
  console.log('PASS push-token predeploy retry: invalid and not-ready remnants recover online')
} finally {
  fallbackCleanup()
}
