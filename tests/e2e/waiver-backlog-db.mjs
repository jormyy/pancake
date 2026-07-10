import { spawn } from 'node:child_process'
import { once } from 'node:events'
import process from 'node:process'

const databaseUrl = process.env.SUPABASE_DB_URL
if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required')
const lockApplicationName = `pancake-waiver-backlog-lock-${process.pid}`

const LOCK_SQL = String.raw`
SELECT pg_advisory_lock(
  hashtext('00000000-0000-0000-0000-000000050101'),
  hashtext('00000000-0000-0000-0000-000000050301')
);
SELECT pg_sleep(300);
`

const CLEANUP_SQL = String.raw`
DELETE FROM public.leagues
 WHERE id IN (
  '00000000-0000-0000-0000-000000050101',
  '00000000-0000-0000-0000-000000050102'
 );
DELETE FROM public.players
 WHERE id IN (
  '00000000-0000-0000-0000-000000050401',
  '00000000-0000-0000-0000-000000050402'
 ) OR id IN (SELECT md5('waiver-backlog-player-' || series)::uuid FROM generate_series(1, 130) AS series);
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000050001';
`

const runPsql = (args, { allowFailure = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn('psql', [databaseUrl, '--set', 'ON_ERROR_STOP=1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0 || allowFailure) resolve({ code, stdout, stderr })
    else reject(new Error(`psql exited ${code}:\n${stdout}${stderr}`))
  })
})

const waitForLock = async (child) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Advisory lock holder exited ${child.exitCode}`)
    const result = await runPsql([
      '--tuples-only',
      '--no-align',
      '--command',
      String.raw`SELECT lock.pid FROM pg_locks AS lock
        JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
        WHERE lock.locktype = 'advisory'
          AND lock.granted
          AND lock.classid::bigint = (hashtext('00000000-0000-0000-0000-000000050101')::bigint & 4294967295)
          AND lock.objid::bigint = (hashtext('00000000-0000-0000-0000-000000050301')::bigint & 4294967295)
          AND lock.objsubid = 2
          AND activity.application_name = '${lockApplicationName}'`,
    ])
    const backendPid = Number(result.stdout.trim())
    if (Number.isInteger(backendPid) && backendPid > 0) return backendPid
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for exact advisory lock')
}

const lockHolder = spawn(
  'psql',
  [databaseUrl, '--quiet', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', LOCK_SQL],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGAPPNAME: lockApplicationName },
  },
)
const lockHolderClosed = once(lockHolder, 'close')

let failure = null
let lockBackendPid = null
try {
  lockBackendPid = await waitForLock(lockHolder)
  const result = await runPsql(['--file', 'tests/db/waiver-backlog-behavior.sql'])
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} catch (error) {
  failure = error
} finally {
  if (lockBackendPid !== null) {
    const termination = await runPsql([
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${lockBackendPid} AND application_name = '${lockApplicationName}'`,
    ], { allowFailure: true })
    if (termination.code !== 0) {
      const terminationError = new Error(`Waiver backlog lock backend termination failed:\n${termination.stdout}${termination.stderr}`)
      failure = failure
        ? new AggregateError([failure, terminationError], 'Waiver backlog test and backend termination failed')
        : terminationError
    }
  } else if (lockHolder.exitCode === null) {
    lockHolder.kill('SIGTERM')
  }
  if (lockHolder.exitCode === null) {
    const closed = await Promise.race([
      lockHolderClosed.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
    if (!closed && lockHolder.exitCode === null) lockHolder.kill('SIGKILL')
  }
  const cleanup = await runPsql(['--command', CLEANUP_SQL], { allowFailure: true })
  if (cleanup.code !== 0) {
    const cleanupError = new Error(`Waiver backlog cleanup failed:\n${cleanup.stdout}${cleanup.stderr}`)
    failure = failure ? new AggregateError([failure, cleanupError], 'Waiver backlog test and cleanup failed') : cleanupError
  }
  let leakCheck = { code: 1, stdout: '', stderr: 'resource leak check did not run' }
  let leaked = true
  for (let attempt = 0; attempt < 50; attempt += 1) {
    leakCheck = await runPsql([
      '--tuples-only',
      '--no-align',
      '--command',
      String.raw`SELECT json_build_object(
        'backends', (SELECT count(*) FROM pg_stat_activity WHERE application_name = '${lockApplicationName}'),
        'locks', (SELECT count(*) FROM pg_locks
          WHERE locktype = 'advisory'
            AND granted
            AND classid::bigint = (hashtext('00000000-0000-0000-0000-000000050101')::bigint & 4294967295)
            AND objid::bigint = (hashtext('00000000-0000-0000-0000-000000050301')::bigint & 4294967295)
            AND objsubid = 2)
      )`,
    ], { allowFailure: true })
    try {
      const state = JSON.parse(leakCheck.stdout.trim())
      leaked = leakCheck.code !== 0 || Number(state.backends) !== 0 || Number(state.locks) !== 0
    } catch {
      leaked = true
    }
    if (!leaked) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (leaked) {
    const leakError = new Error(`Waiver backlog lock resources leaked:\n${leakCheck.stdout}${leakCheck.stderr}`)
    failure = failure ? new AggregateError([failure, leakError], 'Waiver backlog test and resource cleanup failed') : leakError
  }
}

if (failure) throw failure
console.log('PASS waiver backlog: behavior and lock resources cleaned up')
