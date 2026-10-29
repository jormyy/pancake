import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { databaseEnvironment, localKeys, sql } from '../../scripts/season-sim/local-stack.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const env = databaseEnvironment(new URL(localKeys().DB_URL))
const directory = path.join(miniRoot, 'paired-state')
await mkdir(directory, { recursive: true, mode: 0o700 })
const file = path.join(directory, 'initial.dump')
const [mode, label] = process.argv.slice(2)
if (mode === 'save') {
  assert.equal(await sql('SELECT to_regprocedure(\'pg_catalog.season_sim_native_now()\') IS NULL'), 't')
  const bytes = execFileSync('docker', ['exec', config.container, 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres',
    '--format=custom', '--data-only', '--no-owner', '--no-privileges',
    ...['public', 'private', 'auth', 'analytics'].flatMap(schema => ['--schema', schema])], { maxBuffer: 256 * 1024 * 1024 })
  await writeFile(file, bytes, { flag: 'wx' })
  await chmod(file, 0o600)
  console.log('Saved initial private table state')
} else if (mode === 'restore') {
  assert.equal(await sql('SELECT to_regprocedure(\'pg_catalog.season_sim_native_now()\') IS NULL'), 't')
  const tables = JSON.parse(await sql("SELECT jsonb_agg(format('%I.%I',schemaname,tablename)) FROM pg_tables WHERE schemaname IN ('public','private','auth','analytics')"))
  await sql(`BEGIN; SET LOCAL session_replication_role=replica; TRUNCATE ${tables.join(',')} RESTART IDENTITY CASCADE; COMMIT;`)
  execFileSync('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c session_replication_role=replica', config.container,
    'pg_restore', '-U', 'supabase_admin', '--data-only', '--no-owner', '--no-privileges', '--dbname', 'postgres'],
  { input: await readFile(file), stdio: ['pipe', 'ignore', 'pipe'] })
  console.log('Restored initial private table state')
} else if (mode === 'clean-queue') {
  const jobs = JSON.parse(await sql("SELECT coalesce(jsonb_agg(t),'[]') FROM (SELECT status,count(*) AS rows,min(due_at) AS first_due,max(lease_until) AS last_lease FROM private.work_items GROUP BY status ORDER BY status) t"))
  await sql('BEGIN; DELETE FROM public.edge_invocations WHERE work_item_id IS NOT NULL; DELETE FROM private.work_items; COMMIT;')
  await rename(file, path.join(directory, 'initial-before-queue-reset.dump'))
  await writeFile(path.join(directory, 'queue-reset.json'), `${JSON.stringify({ source: 'Work queue was introduced after the restored backup schema. These rows came from earlier harness runs.', jobs }, null, 2)}\n`)
  console.log(JSON.stringify({ clearedHarnessQueue: jobs }))
} else if (mode === 'retire-harness-leagues') {
  const leagues = JSON.parse(await sql("SELECT coalesce(jsonb_agg(l.id ORDER BY l.id),'[]') FROM public.leagues l WHERE l.name ~ '^Historical replay [0-9a-f]{12}$'"))
  await sql("BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.league_seasons s SET is_current=false FROM public.leagues l WHERE l.id=s.league_id AND l.name ~ '^Historical replay [0-9a-f]{12}$'; COMMIT;")
  await rename(file, path.join(directory, 'initial-with-prior-harness-leagues.dump'))
  await writeFile(path.join(directory, 'retired-harness-leagues.json'), `${JSON.stringify({ leagues }, null, 2)}\n`)
  console.log(JSON.stringify({ retiredPriorHarnessLeagues: leagues }))
} else if (mode === 'capture') {
  assert.match(label, /^[a-z0-9-]+$/)
  const tables = ['public.players', 'public.nba_games', 'public.player_game_stats', 'analytics.player_season_totals',
    'public.player_projections', 'public.sleeper_projection_rows', 'private.player_game_memberships', 'private.game_stat_revisions']
  const rows = []
  for (const table of tables) {
    const bytes = execFileSync('psql', ['-XqAt', '--set', 'ON_ERROR_STOP=1', '-c',
      `COPY (SELECT to_jsonb(t)::text FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C") TO STDOUT`], { env, maxBuffer: 256 * 1024 * 1024 })
    rows.push({ table, rows: bytes.toString().split('\n').length - 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(path.join(directory, `${label}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  console.log(JSON.stringify(rows))
} else if (mode === 'compare') {
  const reference = JSON.parse(await readFile(path.join(directory, 'reference.json'), 'utf8'))
  const candidate = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'))
  assert.deepEqual(candidate, reference, 'All stored ingest table bytes must match')
  console.log('Eight complete ingest tables match byte for byte')
} else assert.fail('Expected save, restore, capture, or compare')
