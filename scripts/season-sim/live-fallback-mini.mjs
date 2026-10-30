import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-live2/repo')
assert.equal(process.cwd(), root)
const stackEnv = { ...process.env, DOCKER_HOST: `unix://${path.join(homedir(), 'pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock')}` }
const output = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: stackEnv })
const keys = Object.fromEntries(output.split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
assert.equal(new URL(keys.API_URL).origin, 'http://127.0.0.1:63621')
assert.equal(new URL(keys.DB_URL).port, '63622')
const args = process.argv.slice(2)
const compare = args.includes('--compare')
const sql = statement => execFileSync('docker', ['exec', 'supabase_db_pt4bafablelv', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { env: stackEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
const modes = compare ? ['espn', 'nba'] : ['espn']
for (const mode of modes) {
  if (compare) {
    sql(`DELETE FROM private.live_poll_game_state WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id IN ('0022600144','0022600145'));
      DELETE FROM public.player_game_stats WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id IN ('0022600144','0022600145'));
      DELETE FROM private.live_feed_state WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id IN ('0022600144','0022600145'));
      DELETE FROM private.live_feed_audit WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id IN ('0022600144','0022600145'));
      UPDATE public.nba_games SET status='Scheduled',home_score=0,away_score=0,game_status_text='Scheduled',stats_synced_at=NULL,
        live_stats_elapsed_seconds=NULL,live_scoreboard_elapsed_seconds=NULL WHERE nba_game_id IN ('0022600144','0022600145')`)
  }
  let baselineRoot
  if (mode === 'nba') {
    const directory = path.resolve(root, '../baseline')
    await mkdir(directory, { recursive: true })
    const archive = execFileSync('git', ['archive', '892b6bca', 'supabase/functions'], { maxBuffer: 32 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    baselineRoot = path.join(directory, 'supabase/functions')
  }
  const result = spawnSync('deno', ['run', '--no-lock', '--allow-env', '--allow-read', '--allow-write=../', '--allow-net=127.0.0.1:63621', 'tests/db/live-fallback-replay.mjs', ...args.filter(arg => arg !== '--compare')], {
    stdio: 'inherit', env: { ...stackEnv, SUPABASE_URL: keys.API_URL, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY ?? keys.SECRET_KEY,
      LIVE_REPLAY_MODE: mode, ...(baselineRoot ? { LIVE_REPLAY_FUNCTIONS_ROOT: baselineRoot } : {}) },
  })
  assert.equal(result.status, 0, `${mode} replay failed`)
}
if (compare) {
  const espn = JSON.parse(await readFile('../live-fallback-espn-result.json', 'utf8'))
  const nba = JSON.parse(await readFile('../live-fallback-nba-result.json', 'utf8'))
  assert.deepEqual(espn.publications.map(row => `${row.espnId}:${row.points}`).sort(), nba.publications.map(row => `${row.espnId}:${row.points}`).sort())
  const comparison = { samples: espn.samples, espnPrimaryP95Ms: espn.p95LagMs, nbaPrimaryP95Ms: nba.p95LagMs, gainMs: nba.p95LagMs - espn.p95LagMs,
    targetMet: espn.p95LagMs < 90_000, pollIntervalMs: espn.pollIntervalMs, injectedNbaLagMs: espn.injectedNbaLagMs, baseline: 'Unmodified main 892b6bca live-poll; same recorded NBA and ESPN sources, clock and database scoring path' }
  await writeFile('../live-fallback-comparison.json', JSON.stringify(comparison, null, 2))
  console.log(JSON.stringify(comparison))
  if (!args.includes('--measure-only')) assert.ok(comparison.targetMet, `Live lag target failed: ${Math.round(espn.p95LagMs)} ms p95 is not under 90000 ms`)
}
