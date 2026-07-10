import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { envValue, requireEnv, resolvedEnv } from './env.mjs'

const RANGE = { startDate: '1947-03-01', endDate: '1947-03-03' }
const JOB_TYPE = `sync_stats_range:${RANGE.startDate}:${RANGE.endDate}`
const LEGACY_RANGE = { startDate: '1947-04-01', endDate: '1947-04-03' }
const LEGACY_JOB_TYPE = `sync_stats_range:${LEGACY_RANGE.startDate}:${LEGACY_RANGE.endDate}`
const LEGACY_JOB_ID = '00000000-0000-4000-8000-00000000000f'
const POST_MIGRATION_LEGACY_RANGE = { startDate: '1947-05-01', endDate: '1947-05-03' }
const POST_MIGRATION_LEGACY_JOB_TYPE = `sync_stats_range:${POST_MIGRATION_LEGACY_RANGE.startDate}:${POST_MIGRATION_LEGACY_RANGE.endDate}`
const POST_MIGRATION_LEGACY_JOB_ID = '00000000-0000-4000-8000-00000000001f'
const TERMINAL_RANGE = { startDate: '1947-06-01', endDate: '1947-06-02' }
const TERMINAL_JOB_TYPE = `sync_stats_range:${TERMINAL_RANGE.startDate}:${TERMINAL_RANGE.endDate}`
const MALFORMED_RANGE = { startDate: '1947-07-01', endDate: '1947-07-02' }
const MALFORMED_JOB_TYPE = `sync_stats_range:${MALFORMED_RANGE.startDate}:${MALFORMED_RANGE.endDate}`
const INVALID_JOB_TYPE = 'sync_stats_range:1947-02-30:1947-03-01'
const INVALID_JOB_ID = '00000000-0000-4000-8000-00000000002f'
const configured = resolvedEnv()
const internalToken = envValue('PANCAKE_EDGE_INTERNAL_TOKEN', 'EDGE_FUNCTION_INTERNAL_TOKEN') ??
  (configured.supabaseUrl && ['127.0.0.1', 'localhost'].includes(new URL(configured.supabaseUrl).hostname)
    ? 'pancake-local-edge-auth-probe-token'
    : undefined)
const env = requireEnv({ ...configured, internalToken }, ['supabaseUrl', 'serviceRoleKey', 'dbUrl', 'internalToken'])
const REQUEST_TIMEOUT_MS = 15_000
const boundedFetch = (input, init = {}) => fetch(input, {
  ...init,
  signal: init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
})
const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
  auth: { persistSession: false },
  global: { fetch: boundedFetch },
})

function scalar(sql) {
  const result = spawnSync('psql', [env.dbUrl, '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--command', sql], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message || 'psql failed')
  return result.stdout.trim()
}

async function rpc(name, args) {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
}

async function rpcResult(name, args) {
  return admin.rpc(name, args)
}

async function assertRpcRejected(name, args, expectedError, failureMessage) {
  const { error } = await rpcResult(name, args)
  assert.ok(error, failureMessage)
  assert.match(error.message, expectedError)
}

async function invokeStatsWorker(jobId) {
  const response = await fetch(`${env.supabaseUrl.replace(/\/$/, '')}/functions/v1/sync-stats`, {
    method: 'POST',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'x-internal-function-token': env.internalToken,
    },
    body: JSON.stringify({ jobId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function invokeStatsDispatcher() {
  const response = await fetch(`${env.supabaseUrl.replace(/\/$/, '')}/functions/v1/sync-stats`, {
    method: 'POST',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      'Content-Type': 'application/json',
      'x-internal-function-token': env.internalToken,
    },
    body: JSON.stringify({ dispatch: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function cleanup() {
  scalar(`DELETE FROM public.sync_jobs WHERE job_type IN ('${JOB_TYPE}', '${LEGACY_JOB_TYPE}', '${POST_MIGRATION_LEGACY_JOB_TYPE}', '${TERMINAL_JOB_TYPE}', '${MALFORMED_JOB_TYPE}', '${INVALID_JOB_TYPE}');`)
}

try {
  await cleanup()

  scalar(`
    INSERT INTO public.sync_jobs (
      id, job_type, status, total_items, completed_items, failed_items, error_log,
      metadata, started_at, claimed_at, claim_token
    ) VALUES (
      '${LEGACY_JOB_ID}', '${LEGACY_JOB_TYPE}', 'running', 3, 0, 0, '[]'::jsonb,
      '{"startDate":"${LEGACY_RANGE.startDate}","endDate":"${LEGACY_RANGE.endDate}","nextDate":"${LEGACY_RANGE.startDate}"}'::jsonb,
      now(), now() - interval '5 minutes', NULL
    );
  `)
  const earlyLegacyClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })
  assert.equal(earlyLegacyClaims.length, 0, 'live predeploy worker was reclaimed before its drain window elapsed')

  const { error: legacyDrainError } = await admin
    .from('sync_jobs')
    .update({ completed_items: 1 })
    .eq('id', LEGACY_JOB_ID)
  assert.equal(legacyDrainError, null, 'tokenless predeploy worker could not drain before fenced takeover')

  scalar(`
    BEGIN;
    SET LOCAL app.stats_sync_fenced_transition = 'on';
    UPDATE public.sync_jobs SET claimed_at = now() - interval '16 minutes' WHERE id = '${LEGACY_JOB_ID}';
    COMMIT;
  `)
  const legacyTakeoverClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })
  assert.equal(legacyTakeoverClaims.length, 1, 'expired predeploy worker was not reclaimed after its drain window')
  const legacyTakeover = legacyTakeoverClaims[0]

  const { error: staleLegacyWriteError } = await admin
    .from('sync_jobs')
    .update({ status: 'failed', completed_items: 999 })
    .eq('id', LEGACY_JOB_ID)
  assert.ok(staleLegacyWriteError, 'predeploy worker mutated a token-owned stats job after takeover')
  assert.match(staleLegacyWriteError.message, /owned by a fenced claim/)
  assert.equal(await rpc('complete_stats_sync_job_atomic', {
    p_job_id: LEGACY_JOB_ID,
    p_claim_token: legacyTakeover.claim_token,
    p_completed_items: 1,
    p_metadata: { ...LEGACY_RANGE, nextDate: '1947-04-04' },
  }), true, 'fenced owner could not complete after rejecting the stale predeploy worker')

  scalar(`
    INSERT INTO public.sync_jobs (
      id, job_type, status, total_items, completed_items, failed_items, error_log,
      metadata, started_at, created_at, claimed_at, claim_token
    ) VALUES (
      '${POST_MIGRATION_LEGACY_JOB_ID}', '${POST_MIGRATION_LEGACY_JOB_TYPE}', 'pending', 3, 0, 0, '[]'::jsonb,
      '{"startDate":"${POST_MIGRATION_LEGACY_RANGE.startDate}","endDate":"${POST_MIGRATION_LEGACY_RANGE.endDate}","nextDate":"${POST_MIGRATION_LEGACY_RANGE.startDate}"}'::jsonb,
      now() - interval '1 hour', now() - interval '1 hour', NULL, NULL
    );
  `)
  const { error: postMigrationLegacyStartError } = await admin
    .from('sync_jobs')
    .update({
      status: 'running',
      metadata: {
        ...POST_MIGRATION_LEGACY_RANGE,
        nextDate: POST_MIGRATION_LEGACY_RANGE.startDate,
        claimedAt: new Date().toISOString(),
      },
    })
    .eq('id', POST_MIGRATION_LEGACY_JOB_ID)
  assert.equal(postMigrationLegacyStartError, null, 'post-migration legacy worker could not start through its predeploy transition')
  assert.equal(
    scalar(`SELECT claimed_at IS NOT NULL FROM public.sync_jobs WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';`),
    't',
    'post-migration legacy claim did not receive a rollout lease',
  )
  const livePostMigrationLegacyClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: POST_MIGRATION_LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })
  assert.equal(livePostMigrationLegacyClaims.length, 0, 'post-migration legacy worker was reclaimed before its drain window elapsed')

  scalar(`
    BEGIN;
    SET LOCAL app.stats_sync_fenced_transition = 'on';
    UPDATE public.sync_jobs
       SET claimed_at = now() - interval '16 minutes'
     WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';
    COMMIT;
  `)
  const { error: postMigrationLegacyReleaseError } = await admin
    .from('sync_jobs')
    .update({ status: 'pending' })
    .eq('id', POST_MIGRATION_LEGACY_JOB_ID)
  assert.equal(postMigrationLegacyReleaseError, null, 'post-migration legacy worker could not requeue its continuation')
  const { error: postMigrationLegacyContinuationError } = await admin
    .from('sync_jobs')
    .update({
      status: 'running',
      metadata: {
        ...POST_MIGRATION_LEGACY_RANGE,
        nextDate: POST_MIGRATION_LEGACY_RANGE.endDate,
        claimedAt: new Date().toISOString(),
      },
    })
    .eq('id', POST_MIGRATION_LEGACY_JOB_ID)
  assert.equal(postMigrationLegacyContinuationError, null, 'post-migration legacy continuation could not start')
  assert.equal(
    scalar(`SELECT claimed_at > now() - interval '1 minute' FROM public.sync_jobs WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';`),
    't',
    'post-migration legacy continuation retained its expired prior lease',
  )
  assert.equal((await rpc('claim_stats_sync_job_atomic', {
    p_job_id: POST_MIGRATION_LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })).length, 0, 'live post-migration legacy continuation was reclaimed from its retained prior lease')

  scalar(`
    BEGIN;
    SET LOCAL app.stats_sync_fenced_transition = 'on';
    UPDATE public.sync_jobs
       SET claimed_at = now() - interval '16 minutes'
     WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';
    COMMIT;
  `)
  const { error: postMigrationLegacyHeartbeatError } = await admin
    .from('sync_jobs')
    .update({ completed_items: 1 })
    .eq('id', POST_MIGRATION_LEGACY_JOB_ID)
  assert.equal(postMigrationLegacyHeartbeatError, null, 'post-migration legacy checkpoint could not heartbeat')
  assert.equal(
    scalar(`SELECT claimed_at > now() - interval '1 minute' FROM public.sync_jobs WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';`),
    't',
    'post-migration legacy checkpoint did not refresh its rollout lease',
  )
  assert.equal((await rpc('claim_stats_sync_job_atomic', {
    p_job_id: POST_MIGRATION_LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })).length, 0, 'heartbeating post-migration legacy worker was reclaimed')

  scalar(`
    BEGIN;
    SET LOCAL app.stats_sync_fenced_transition = 'on';
    UPDATE public.sync_jobs
       SET claimed_at = NULL,
           created_at = now() - interval '16 minutes'
     WHERE id = '${POST_MIGRATION_LEGACY_JOB_ID}';
    COMMIT;
  `)
  const crashedPostMigrationLegacyClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: POST_MIGRATION_LEGACY_JOB_ID,
    p_stale_after_seconds: 60,
  })
  assert.equal(crashedPostMigrationLegacyClaims.length, 1, 'crashed post-migration legacy worker was not reclaimed after its drain window')
  const postMigrationLegacyTakeover = crashedPostMigrationLegacyClaims[0]

  const { error: stalePostMigrationLegacyWriteError } = await admin
    .from('sync_jobs')
    .update({ status: 'failed', completed_items: 999 })
    .eq('id', POST_MIGRATION_LEGACY_JOB_ID)
  assert.ok(stalePostMigrationLegacyWriteError, 'post-migration legacy worker mutated a token-owned stats job after takeover')
  assert.match(stalePostMigrationLegacyWriteError.message, /owned by a fenced claim/)
  assert.equal(await rpc('complete_stats_sync_job_atomic', {
    p_job_id: POST_MIGRATION_LEGACY_JOB_ID,
    p_claim_token: postMigrationLegacyTakeover.claim_token,
    p_completed_items: 1,
    p_metadata: { ...POST_MIGRATION_LEGACY_RANGE, nextDate: '1947-05-04' },
  }), true, 'fenced owner could not complete a reclaimed post-migration legacy job')

  scalar(`
    INSERT INTO public.sync_jobs (
      id, job_type, status, total_items, completed_items, failed_items, error_log, metadata
    ) VALUES (
      '${INVALID_JOB_ID}', '${INVALID_JOB_TYPE}', 'pending', 1, 0, 0, '[]'::jsonb,
      '{"startDate":"1947-02-30","endDate":"1947-03-01","nextDate":"1947-02-30"}'::jsonb
    );
  `)
  const invalidDispatch = await invokeStatsDispatcher()
  assert.equal(invalidDispatch.status, 200, 'dispatcher surfaced an invalid calendar range to the Edge worker')
  assert.equal(invalidDispatch.body?.status, 'idle', 'dispatcher treated an invalid calendar range as claimable work')
  const { data: invalidJob, error: invalidJobError } = await admin
    .from('sync_jobs')
    .select('status, failed_items, error_log, claim_token, claimed_at')
    .eq('id', INVALID_JOB_ID)
    .single()
  if (invalidJobError) throw invalidJobError
  assert.equal(invalidJob.status, 'failed', 'invalid calendar range was not durably terminalized')
  assert.equal(invalidJob.failed_items, 3, 'invalid calendar range did not consume the bounded retry budget')
  assert.equal(invalidJob.error_log.length, 1)
  assert.match(invalidJob.error_log[0], /invalid stats sync job type/i)
  assert.equal(invalidJob.claim_token, null)
  assert.equal(invalidJob.claimed_at, null)
  assert.equal((await rpc('claim_stats_sync_job_atomic', {
    p_job_id: INVALID_JOB_ID,
    p_stale_after_seconds: 60,
  })).length, 0, 'terminal invalid calendar range was reclaimed')

  const createdIds = await Promise.all(Array.from({ length: 24 }, () =>
    rpc('create_or_resume_stats_sync_job_atomic', {
      p_start_date: RANGE.startDate,
      p_end_date: RANGE.endDate,
    })))
  assert.equal(new Set(createdIds).size, 1, 'concurrent create returned more than one active job id')
  const jobId = createdIds[0]

  const { data: activeRows, error: activeError } = await admin
    .from('sync_jobs')
    .select('id, status')
    .eq('job_type', JOB_TYPE)
    .in('status', ['pending', 'running', 'failed'])
  if (activeError) throw activeError
  assert.deepEqual(activeRows, [{ id: jobId, status: 'pending' }], 'database uniqueness did not converge to one active job')

  const firstClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_stale_after_seconds: 60,
  })
  assert.equal(firstClaims.length, 1, 'first worker did not claim the pending job')
  const firstClaim = firstClaims[0]
  const { error: invalidCheckpointError } = await admin.rpc('checkpoint_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: firstClaim.claim_token,
    p_completed_items: 1,
    p_metadata: { broken: true },
  })
  assert.ok(invalidCheckpointError, 'checkpoint accepted malformed durable stats metadata')
  assert.match(invalidCheckpointError.message, /checkpoint is invalid/)
  const mismatchedMetadata = {
    startDate: '1948-01-01',
    endDate: '1948-01-02',
    nextDate: '1948-01-01',
  }
  const mismatchedTransitionArgs = {
      p_job_id: jobId,
      p_claim_token: firstClaim.claim_token,
      p_completed_items: 1,
      p_metadata: mismatchedMetadata,
  }
  await assertRpcRejected('checkpoint_stats_sync_job_atomic', mismatchedTransitionArgs, /checkpoint is invalid/,
    'checkpoint accepted metadata for a different immutable range')
  await assertRpcRejected('release_stats_sync_job_atomic', mismatchedTransitionArgs, /release is invalid/,
    'release accepted metadata for a different immutable range')
  await assertRpcRejected('complete_stats_sync_job_atomic', mismatchedTransitionArgs, /completion is invalid/,
    'completion accepted metadata for a different immutable range')
  const { error: mismatchedFailureError } = await admin.rpc('fail_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: firstClaim.claim_token,
    p_completed_items: 1,
    p_metadata: mismatchedMetadata,
    p_error: 'must not persist',
  })
  assert.ok(mismatchedFailureError, 'failure transition accepted metadata for a different immutable range')
  assert.match(mismatchedFailureError.message, /failure checkpoint is invalid/)
  assert.equal(await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: RANGE.startDate,
    p_end_date: RANGE.endDate,
  }), jobId, 'same-range retry could not observe a token-owned active job')

  scalar(`
    BEGIN;
    SET LOCAL app.stats_sync_fenced_transition = 'on';
    UPDATE public.sync_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = '${jobId}';
    COMMIT;
  `)
  const secondClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_stale_after_seconds: 60,
  })
  assert.equal(secondClaims.length, 1, 'stale job was not rescued')
  const secondClaim = secondClaims[0]
  assert.notEqual(firstClaim.claim_token, secondClaim.claim_token, 'stale rescue reused its predecessor claim token')

  const staleCheckpoint = await rpc('checkpoint_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: firstClaim.claim_token,
    p_completed_items: 99,
    p_metadata: { ...RANGE, nextDate: RANGE.endDate },
  })
  assert.equal(staleCheckpoint, false, 'superseded worker overwrote the new owner cursor')

  const currentMetadata = { ...RANGE, nextDate: RANGE.startDate }
  assert.equal(await rpc('checkpoint_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: secondClaim.claim_token,
    p_completed_items: 1,
    p_metadata: currentMetadata,
  }), true, 'current worker could not checkpoint')
  assert.equal(await rpc('release_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: secondClaim.claim_token,
    p_completed_items: 1,
    p_metadata: currentMetadata,
  }), true, 'current worker could not release pending work')

  assert.equal(
    scalar("SELECT count(*) FROM cron.job WHERE jobname = 'nba-dispatch-stats-sync-jobs';"),
    '1',
    'durable stats dispatcher cron is not installed',
  )
  assert.match(
    scalar("SELECT command FROM cron.job WHERE jobname = 'nba-dispatch-stats-sync-jobs';"),
    /"dispatch":true,"jobId":"00000000-0000-4000-8000-000000000000"/,
    'dispatcher cron payload is not backward-safe during Edge rollout',
  )
  const rescueClaims = await rpc('claim_stats_sync_job_atomic', {
    p_stale_after_seconds: 60,
  })
  const rescueClaim = rescueClaims.find((claim) => claim.id === jobId)
  assert.ok(rescueClaim, 'generic dispatcher did not rescue pending work after an omitted immediate enqueue')

  assert.equal(await rpc('fail_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: rescueClaim.claim_token,
    p_completed_items: 1,
    p_metadata: currentMetadata,
    p_error: 'injected upstream failure',
  }), true, 'fenced failure transition was not persisted')

  assert.equal((await rpc('claim_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_stale_after_seconds: 60,
  })).length, 0, 'failed continuation retried without its durable backoff')
  scalar(`UPDATE public.sync_jobs SET completed_at = now() - interval '2 minutes' WHERE id = '${jobId}';`)
  const retryClaims = await rpc('claim_stats_sync_job_atomic', {
    p_stale_after_seconds: 60,
  })
  const retryClaim = retryClaims.find((claim) => claim.id === jobId)
  assert.ok(retryClaim, 'dispatcher did not retry an eligible failed continuation')
  assert.equal(await rpc('complete_stats_sync_job_atomic', {
    p_job_id: jobId,
    p_claim_token: retryClaim.claim_token,
    p_completed_items: 1,
    p_metadata: { ...RANGE, nextDate: '1947-03-04' },
  }), true, 'dispatcher retry could not complete the failed continuation')

  const { data: recovered, error: recoveredError } = await admin
    .from('sync_jobs')
    .select('status, completed_items, failed_items, error_log, claim_token, claimed_at')
    .eq('id', jobId)
    .single()
  if (recoveredError) throw recoveredError
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.completed_items, 1)
  assert.equal(recovered.failed_items, 0, 'successful dispatcher retry did not reset consecutive failures')
  assert.deepEqual(recovered.error_log, ['injected upstream failure'])
  assert.equal(recovered.claim_token, null)
  assert.equal(recovered.claimed_at, null)

  const terminalJobId = await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: TERMINAL_RANGE.startDate,
    p_end_date: TERMINAL_RANGE.endDate,
  })
  let terminalClaim = (await rpc('claim_stats_sync_job_atomic', {
    p_job_id: terminalJobId,
    p_stale_after_seconds: 60,
  }))[0]
  assert.ok(terminalClaim, 'terminal retry fixture could not claim its initial attempt')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(await rpc('fail_stats_sync_job_atomic', {
      p_job_id: terminalJobId,
      p_claim_token: terminalClaim.claim_token,
      p_completed_items: 0,
      p_metadata: { ...TERMINAL_RANGE, nextDate: TERMINAL_RANGE.startDate },
      p_error: `injected terminal failure ${attempt}`,
    }), true, `terminal retry attempt ${attempt} was not persisted`)
    scalar(`UPDATE public.sync_jobs SET completed_at = now() - interval '10 minutes' WHERE id = '${terminalJobId}';`)
    const nextClaims = await rpc('claim_stats_sync_job_atomic', {
      p_job_id: terminalJobId,
      p_stale_after_seconds: 60,
    })
    if (attempt < 3) {
      assert.equal(nextClaims.length, 1, `dispatcher did not claim retry attempt ${attempt + 1}`)
      terminalClaim = nextClaims[0]
    } else {
      assert.equal(nextClaims.length, 0, 'dispatcher exceeded the stats retry attempt cap')
    }
  }

  const { data: terminal, error: terminalError } = await admin
    .from('sync_jobs')
    .select('status, failed_items, error_log, claim_token, claimed_at')
    .eq('id', terminalJobId)
    .single()
  if (terminalError) throw terminalError
  assert.equal(terminal.status, 'failed', 'attempt-capped job lost its visible terminal failure state')
  assert.equal(terminal.failed_items, 3)
  assert.equal(terminal.error_log.length, 3)
  assert.equal(terminal.claim_token, null)
  assert.equal(terminal.claimed_at, null)

  const resumedId = await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: TERMINAL_RANGE.startDate,
    p_end_date: TERMINAL_RANGE.endDate,
  })
  assert.equal(resumedId, terminalJobId, 'manual resume created a second terminal job')
  const { data: resumed, error: resumedError } = await admin
    .from('sync_jobs')
    .select('status, failed_items, error_log, claim_token, claimed_at')
    .eq('id', terminalJobId)
    .single()
  if (resumedError) throw resumedError
  assert.equal(resumed.status, 'pending')
  assert.equal(resumed.failed_items, 0, 'manual resume did not reset the bounded retry budget')
  assert.equal(resumed.error_log.length, 3, 'manual resume discarded terminal failure history')
  assert.equal(resumed.claim_token, null)
  assert.equal(resumed.claimed_at, null)

  const malformedJobId = await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: MALFORMED_RANGE.startDate,
    p_end_date: MALFORMED_RANGE.endDate,
  })
  scalar(`UPDATE public.sync_jobs SET metadata = '{"broken":true}'::jsonb WHERE id = '${malformedJobId}';`)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      scalar(`UPDATE public.sync_jobs SET completed_at = now() - interval '10 minutes' WHERE id = '${malformedJobId}';`)
    }
    const result = await invokeStatsWorker(malformedJobId)
    assert.equal(result.status, 500, `malformed Edge attempt ${attempt} did not surface worker failure`)
    const { data: malformedAttempt, error: malformedAttemptError } = await admin
      .from('sync_jobs')
      .select('status, failed_items, error_log, claim_token, claimed_at')
      .eq('id', malformedJobId)
      .single()
    if (malformedAttemptError) throw malformedAttemptError
    assert.equal(malformedAttempt.status, 'failed')
    assert.equal(malformedAttempt.failed_items, attempt, `malformed Edge attempt ${attempt} did not increment its retry count`)
    assert.equal(malformedAttempt.error_log.length, attempt)
    assert.match(malformedAttempt.error_log.at(-1), /Stats sync job .* is invalid/)
    assert.equal(malformedAttempt.claim_token, null)
    assert.equal(malformedAttempt.claimed_at, null)
  }

  scalar(`UPDATE public.sync_jobs SET completed_at = now() - interval '10 minutes' WHERE id = '${malformedJobId}';`)
  const terminalMalformedResult = await invokeStatsWorker(malformedJobId)
  assert.equal(terminalMalformedResult.status, 200, 'terminal malformed job did not return its durable state')
  assert.equal(terminalMalformedResult.body?.status, 'failed')
  assert.equal(
    scalar(`SELECT failed_items FROM public.sync_jobs WHERE id = '${malformedJobId}';`),
    '3',
    'terminal malformed job exceeded the retry cap',
  )

  scalar(`
    UPDATE public.sync_jobs
       SET metadata = '{"startDate":"1948-01-01","endDate":"1948-01-02","nextDate":"1948-01-01"}'::jsonb,
           completed_items = 7,
           total_items = 9
     WHERE id = '${malformedJobId}';
  `)

  const resumedMalformedId = await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: MALFORMED_RANGE.startDate,
    p_end_date: MALFORMED_RANGE.endDate,
  })
  assert.equal(resumedMalformedId, malformedJobId, 'malformed manual resume created a second job')
  const { data: resumedMalformed, error: resumedMalformedError } = await admin
    .from('sync_jobs')
    .select('status, completed_items, failed_items, error_log, metadata, claim_token, claimed_at')
    .eq('id', malformedJobId)
    .single()
  if (resumedMalformedError) throw resumedMalformedError
  const repairedMetadata = { ...MALFORMED_RANGE, nextDate: MALFORMED_RANGE.startDate }
  assert.equal(resumedMalformed.status, 'pending')
  assert.equal(resumedMalformed.completed_items, 0, 'malformed manual resume retained poisoned progress')
  assert.equal(resumedMalformed.failed_items, 0, 'malformed manual resume did not reset the retry budget')
  assert.equal(resumedMalformed.error_log.length, 3, 'malformed manual resume discarded failure history')
  assert.deepEqual(resumedMalformed.metadata, repairedMetadata)
  assert.equal(resumedMalformed.claim_token, null)
  assert.equal(resumedMalformed.claimed_at, null)

  const repairedClaims = await rpc('claim_stats_sync_job_atomic', {
    p_job_id: malformedJobId,
    p_stale_after_seconds: 60,
  })
  assert.equal(repairedClaims.length, 1, 'repaired malformed job could not be claimed')
  assert.deepEqual(repairedClaims[0].metadata, repairedMetadata)
  assert.equal(await rpc('release_stats_sync_job_atomic', {
    p_job_id: malformedJobId,
    p_claim_token: repairedClaims[0].claim_token,
    p_completed_items: 0,
    p_metadata: repairedMetadata,
  }), true, 'repaired malformed job metadata did not pass durable validation')

  const repairedResult = await invokeStatsWorker(malformedJobId)
  assert.equal(repairedResult.status, 200, 'repaired malformed job did not complete through the Edge worker')
  assert.equal(repairedResult.body?.status, 'completed')
  const { data: repairedJob, error: repairedJobError } = await admin
    .from('sync_jobs')
    .select('status, failed_items, error_log, claim_token, claimed_at')
    .eq('id', malformedJobId)
    .single()
  if (repairedJobError) throw repairedJobError
  assert.equal(repairedJob.status, 'completed')
  assert.equal(repairedJob.failed_items, 0)
  assert.equal(repairedJob.error_log.length, 3, 'successful malformed recovery discarded failure history')
  assert.equal(repairedJob.claim_token, null)
  assert.equal(repairedJob.claimed_at, null)

  console.log('PASS stats sync jobs: rollout rescue, fencing, dispatcher recovery, terminal cap, and malformed-job repair')
} finally {
  await cleanup()
}
