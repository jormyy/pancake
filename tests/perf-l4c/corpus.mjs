import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

process.env.SEASON_SIM_YEAR = '2027'
process.env.SEASON_SIM_FIXTURES = `${process.env.SEASON_SIM_ROOT}/window-fixtures`
process.env.SEASON_SIM_ORIGIN_FIXTURES = process.env.SEASON_SIM_FIXTURES
process.env.SEASON_SIM_DATABASE_WINDOW = `${process.env.SEASON_SIM_ROOT}/database-window.json`
const { config, miniRoot } = await import('../../scripts/season-sim/common.mjs')
const { localKeys, databaseEnvironment, sql } = await import('../../scripts/season-sim/local-stack.mjs')
const { setClock } = await import('../../scripts/season-sim/clock.mjs')
const { startOrigin } = await import('../../scripts/season-sim/origin.mjs')
const { fixtureStore } = await import('../../scripts/season-sim/fixtures.mjs')
const { gameEndTime, orderedActions } = await import('../../scripts/season-sim/snapshots.mjs')
const { assertFinals } = await import('../../scripts/season-sim/assertions.mjs')
assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const label = process.argv[2]
assert.ok(['reference', 'candidate'].includes(label))
const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
const source = label === 'reference' ? path.join(miniRoot, 'reference') : process.cwd()
await mkdir(source, { recursive: true })
if (label === 'reference') execFileSync('tar', ['-xf', '-', '-C', source], {
  input: execFileSync('git', ['archive', 'ec739102', 'supabase/functions'], { maxBuffer: 32 * 1024 * 1024 }),
})
for (const name of ['link_player_sources_atomic', 'save_game_stats_atomic', 'resolve_player_imports_atomic']) {
  const file = `supabase/sql/functions/by-name/public/${name}.sql`
  await sql(label === 'reference' ? execFileSync('git', ['show', `ec739102:${file}`], { encoding: 'utf8' }) : await readFile(file, 'utf8'))
}
const dates = ['2026-10-29', '2026-10-30']
const games = JSON.parse(await readFile(path.join(process.env.SEASON_SIM_FIXTURES, 'games.json'), 'utf8')).games.filter(game => dates.includes(game.date))
const store = await fixtureStore(process.env.SEASON_SIM_FIXTURES)
const frames = new Set()
for (const game of games) {
  const end = gameEndTime(orderedActions(await store.json(`playbyplay-${game.id}`)))
  for (let at = Date.parse(game.time) - 60000; at <= end + 60000; at += 30000) frames.add(at)
  frames.add(end + 31 * 60000)
}
const ordered = [...frames].sort((a, b) => a - b)
assert.ok(games.length > 0 && ordered.length > 100)
await sql(`BEGIN;
  DELETE FROM public.player_game_stats WHERE game_id IN (SELECT id FROM public.nba_games WHERE game_date BETWEEN '${dates[0]}' AND '${dates[1]}' AND season_year=2027);
  DELETE FROM private.game_stat_revisions WHERE game_id IN (SELECT id FROM public.nba_games WHERE game_date BETWEEN '${dates[0]}' AND '${dates[1]}' AND season_year=2027);
  DELETE FROM private.live_poll_game_state WHERE game_id IN (SELECT id FROM public.nba_games WHERE game_date BETWEEN '${dates[0]}' AND '${dates[1]}' AND season_year=2027);
  UPDATE public.nba_games SET status='Scheduled',home_score=0,away_score=0,stats_synced_at=NULL,live_stats_elapsed_seconds=0
  WHERE game_date BETWEEN '${dates[0]}' AND '${dates[1]}' AND season_year=2027;
  COMMIT;`)
await setClock({ at: new Date(ordered[0]).toISOString(), install: true, rate: 0 })
let origin
try {
  origin = await startOrigin()
  const child = spawn('deno', ['run', '--allow-env', '--allow-read', '--allow-write', '--allow-run=psql',
    '--allow-net=127.0.0.1:63021,127.0.0.1:63080', 'tests/perf-l4c/corpus-run.mjs', source, JSON.stringify(ordered)], {
    env: { ...process.env, ...databaseEnvironment(new URL(keys.DB_URL)), SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
      NBA_CDN_BASE_URL: 'http://127.0.0.1:63080/static/json', ESPN_SITE_BASE_URL: 'http://127.0.0.1:63080/espn' }, stdio: 'inherit',
  })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
  const finals = []
  for (const date of dates) finals.push(await assertFinals(date))
  const applicationCommit = label === 'reference' ? 'ec739102' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  await writeFile(path.join(miniRoot, `evidence/corpus-${label}.json`), `${JSON.stringify({ label, applicationCommit, games: games.length, frames: ordered.length, finals, passed: true }, null, 2)}\n`)
} finally {
  if (origin) await new Promise(resolve => origin.close(resolve))
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
