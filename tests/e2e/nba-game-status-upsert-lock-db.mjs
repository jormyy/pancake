import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

// Live-poll writes game status with an upsert keyed by id (same columns as supabase/functions/live-poll). While
// scoring holds the shared game-source lock for a season, that status write must still succeed; only a real
// identity change (date, teams, season, provider id) must wait for scoring.
const databaseUrl = process.env.SUPABASE_DB_URL
if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required')
const season = 2163
const gameId = randomUUID()
const providerId = `00991${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`
const lockApplicationName = `pancake-nba-source-scoring-${process.pid}`
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

const runPsql = (args, { allowFailure = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn('psql', [databaseUrl, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
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

const upsertStatus = (status) => runPsql(['--tuples-only', '--no-align', '--command', `
  INSERT INTO public.nba_games (id, game_date, home_team, away_team, season_year, week_number, status, home_score, away_score, game_status_text, updated_at)
  VALUES ('${gameId}', '${today}', 'ZUA', 'ZUB', ${season}, 1, '${status}', 12, 10, 'Q2 5:00', now())
  ON CONFLICT (id) DO UPDATE SET game_date = EXCLUDED.game_date, home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team,
    season_year = EXCLUDED.season_year, week_number = EXCLUDED.week_number, status = EXCLUDED.status, home_score = EXCLUDED.home_score,
    away_score = EXCLUDED.away_score, game_status_text = EXCLUDED.game_status_text, updated_at = EXCLUDED.updated_at;
  SELECT status FROM public.nba_games WHERE id = '${gameId}';`], { allowFailure: true })

await runPsql(['--command', `INSERT INTO public.nba_games (id, season_year, week_number, game_date, home_team, away_team, status, nba_game_id)
  VALUES ('${gameId}', ${season}, 1, '${today}', 'ZUA', 'ZUB', 'Scheduled', '${providerId}')`])

const lockHolder = spawn('psql', [databaseUrl, '--quiet', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command',
  `SELECT pg_advisory_lock_shared(hashtext('nba-source'), ${season}); SELECT pg_sleep(120);`],
{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGAPPNAME: lockApplicationName } })
const lockHolderClosed = once(lockHolder, 'close')

let failure = null
try {
  let held = false
  for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
    const result = await runPsql(['--tuples-only', '--no-align', '--command', `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock' AND a.application_name = '${lockApplicationName}'`])
    held = result.stdout.trim() === '1'
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!held) throw new Error('Timed out waiting for the scoring-side shared lock')

  const write = await upsertStatus('InProgress')
  if (write.code !== 0 || write.stdout.trim() !== 'InProgress') {
    throw new Error(`Live status upsert failed while scoring held its shared lock:\n${write.stdout}${write.stderr}`)
  }
  const identity = await runPsql(['--command', `UPDATE public.nba_games SET game_date = game_date + 1 WHERE id = '${gameId}'`], { allowFailure: true })
  if (identity.code === 0 || !/being updated/.test(identity.stderr)) {
    throw new Error(`An identity change did not wait for scoring:\n${identity.stdout}${identity.stderr}`)
  }
  console.log(JSON.stringify({ statusUpsertDuringScoring: 'applied', identityChangeDuringScoring: 'refused' }))
} catch (error) {
  failure = error
} finally {
  await runPsql(['--command', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${lockApplicationName}'`], { allowFailure: true })
  if (lockHolder.exitCode === null) {
    const closed = await Promise.race([lockHolderClosed.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))])
    if (!closed && lockHolder.exitCode === null) lockHolder.kill('SIGKILL')
  }
  const cleanup = await runPsql(['--command', `DELETE FROM public.nba_games WHERE id = '${gameId}'`], { allowFailure: true })
  if (cleanup.code !== 0 && !failure) failure = new Error(`Cleanup failed:\n${cleanup.stderr}`)
}
if (failure) throw failure
