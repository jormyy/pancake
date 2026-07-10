import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { requireEnv, resolvedEnv } from './env.mjs'

const RANGE = { startDate: '1947-03-01', endDate: '1947-03-03' }
const JOB_TYPE = `sync_stats_range:${RANGE.startDate}:${RANGE.endDate}`
const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey', 'dbUrl'])
const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })

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

async function cleanup() {
  scalar(`DELETE FROM public.sync_jobs WHERE job_type = '${JOB_TYPE}';`)
}

try {
  await cleanup()

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

  scalar(`UPDATE public.sync_jobs SET claimed_at = now() - interval '5 minutes' WHERE id = '${jobId}';`)
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
  const resumedId = await rpc('create_or_resume_stats_sync_job_atomic', {
    p_start_date: RANGE.startDate,
    p_end_date: RANGE.endDate,
  })
  assert.equal(resumedId, jobId, 'retry created a second job instead of resuming the failed cursor')

  const { data: resumed, error: resumedError } = await admin
    .from('sync_jobs')
    .select('status, completed_items, failed_items, error_log, claim_token, claimed_at')
    .eq('id', jobId)
    .single()
  if (resumedError) throw resumedError
  assert.equal(resumed.status, 'pending')
  assert.equal(resumed.completed_items, 1)
  assert.equal(resumed.failed_items, 1)
  assert.deepEqual(resumed.error_log, ['injected upstream failure'])
  assert.equal(resumed.claim_token, null)
  assert.equal(resumed.claimed_at, null)

  console.log('PASS stats sync jobs: concurrent dedupe, fencing, dispatcher rescue, and failure resume')
} finally {
  await cleanup()
}
