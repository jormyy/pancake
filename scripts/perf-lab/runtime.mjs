import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { labRoot, ports, project, target, json, requireMini } from './common.mjs'
import { localKeys, sql } from './database.mjs'
import { captureProcessOutput } from './bounded-log.mjs'

export const clearSyntheticImageIdsSql = `UPDATE public.players SET nba_id=NULL
  WHERE ((sportsdata_id LIKE 'ios-sim-%' AND nba_id ~ '^IOS[0-9]+$')
    OR (sportsdata_id LIKE 'e2e-player-%' AND nba_id ~ '^E2ENBA[0-9]+$')) RETURNING id;`

export async function startEdge(evidence) {
  await requireMini()
  const keys = await localKeys()
  const token = randomBytes(32).toString('hex')
  await sql(`ALTER DATABASE postgres SET app.supabase_url = 'http://host.lima.internal:${ports.edge}'; ALTER DATABASE postgres SET app.edge_internal_token = '${token}';`)
  const child = spawn('deno', ['run', '--cached-only', '--node-modules-dir=manual', '--allow-sys', '--allow-read', '--allow-write', '--allow-env', `--allow-net=127.0.0.1:${ports.api},localhost:${ports.api},127.0.0.1:${ports.edge},127.0.0.1:${ports.fixtures}`, 'scripts/perf-lab/edge.mjs'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DENO_DIR: process.env.DENO_DIR, DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1', PERF_LAB_ON_MINI: '1', PERF_LAB_LANE: target.lane, PERF_LAB_PROJECT: project, PERF_LAB_PORT_PREFIX: target.prefix,
      SUPABASE_URL: keys.API_URL, SUPABASE_ANON_KEY: keys.ANON_KEY, SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
      PANCAKE_EDGE_INTERNAL_TOKEN: token, PERF_LAB_EVIDENCE: evidence, PERF_LAB_EDGE_PORT: String(ports.edge), PERF_LAB_HEADSHOTS: path.join(labRoot, 'fixtures/headshots') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = captureProcessOutput(child, path.join(evidence, 'edge.log'))
  let failure
  child.on('error', error => { failure = error })
  const close = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('close', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await stopped
      clearTimeout(timer)
    }
    await log.close()
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.ok(!failure && child.exitCode === null, `Local Edge startup failed; inspect ${path.join(evidence, 'edge.log')}`)
      const healthy = await fetch(`http://127.0.0.1:${ports.edge}/health`).then(response => response.ok).catch(() => false)
      if (healthy) return { close, keys, pid: child.pid, token }
      await delay(500)
    }
    throw new Error('Local Edge startup timed out')
  } catch (error) { await close(); throw error }
}

export async function seedScreens(keys) {
  await requireMini()
  const { seed } = await import('../ios-sim/seed.mjs')
  const directory = path.join(labRoot, 'seed')
  const slate = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT id,game_time,status,started_at FROM nba_games
    WHERE game_date BETWEEN (now() AT TIME ZONE 'America/New_York')::date-1 AND (now() AT TIME ZONE 'America/New_York')::date) r;`))
  let fixture
  try {
    await sql(`UPDATE nba_games SET game_time=now()+interval '1 day',started_at=NULL,status='Scheduled'
      WHERE game_date BETWEEN (now() AT TIME ZONE 'America/New_York')::date-1 AND (now() AT TIME ZONE 'America/New_York')::date;`)
    fixture = await seed({ stack: { url: keys.API_URL, serviceKey: keys.SERVICE_ROLE_KEY, anonKey: keys.ANON_KEY, project }, snapshot: process.cwd(), directory })
    const cleared = await sql(clearSyntheticImageIdsSql)
    await json(path.join(labRoot, 'evidence/synthetic-image-identities.json'), { cleared: cleared ? cleared.split('\n').length : 0, reason: 'Synthetic players have no NBA headshot identity' })
  } finally {
    await sql(`UPDATE nba_games game SET game_time=restored.game_time,status=restored.status,started_at=restored.started_at
      FROM jsonb_populate_recordset(NULL::public.nba_games,'${JSON.stringify(slate).replaceAll("'", "''")}'::jsonb) restored WHERE game.id=restored.id;`)
    await json(path.join(labRoot, 'evidence/fixture-preparation.json'), { delayedExistingGamesDuringConstruction: slate.length, restored: true })
  }
  return { url: keys.API_URL, serviceKey: keys.SERVICE_ROLE_KEY, anonKey: keys.ANON_KEY, project, fixture }
}
