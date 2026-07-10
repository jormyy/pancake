import { spawn } from 'node:child_process'
import { once } from 'node:events'
import process from 'node:process'

const databaseUrl = process.env.SUPABASE_DB_URL
if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required')

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
 );
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
      "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted",
    ])
    if (Number(result.stdout.trim()) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for advisory lock')
}

const lockHolder = spawn(
  'psql',
  [databaseUrl, '--quiet', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', LOCK_SQL],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let failure = null
try {
  await waitForLock(lockHolder)
  const result = await runPsql(['--file', 'tests/db/waiver-backlog-behavior.sql'])
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} catch (error) {
  failure = error
} finally {
  if (lockHolder.exitCode === null) {
    lockHolder.kill('SIGTERM')
    await once(lockHolder, 'close').catch(() => {})
  }
  const cleanup = await runPsql(['--command', CLEANUP_SQL], { allowFailure: true })
  if (cleanup.code !== 0) {
    const cleanupError = new Error(`Waiver backlog cleanup failed:\n${cleanup.stdout}${cleanup.stderr}`)
    failure = failure ? new AggregateError([failure, cleanupError], 'Waiver backlog test and cleanup failed') : cleanupError
  }
}

if (failure) throw failure
