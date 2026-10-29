import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { sql } from '../../scripts/season-sim/local-stack.mjs'
import { edgeWindowCosts } from './window-costs.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const label = process.argv[2] ?? 'candidate'
assert.match(label, /^[a-z0-9-]+$/)
const reference = label.startsWith('reference')
const applicationCommit = reference ? 'ec739102' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const functions = path.join(miniRoot, 'reference/supabase/functions')
if (reference) {
  await mkdir(path.join(miniRoot, 'reference'), { recursive: true })
  execFileSync('tar', ['-xf', '-', '-C', path.join(miniRoot, 'reference')], {
    input: execFileSync('git', ['archive', 'ec739102', 'supabase/functions'], { maxBuffer: 32 * 1024 * 1024 }),
  })
}
for (const name of ['link_player_sources_atomic', 'save_game_stats_atomic', 'resolve_player_imports_atomic']) {
  const file = `supabase/sql/functions/by-name/public/${name}.sql`
  await sql(reference ? execFileSync('git', ['show', `ec739102:${file}`], { encoding: 'utf8' }) : await readFile(file, 'utf8'))
}
const startDate = process.env.L4C_REPLAY_START ?? '2026-10-29'
assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/)
const games = JSON.parse(await readFile(path.join(miniRoot, 'window-fixtures/games.json'), 'utf8')).games
const first = games.filter(game => game.date === startDate).map(game => Date.parse(game.time)).sort((a, b) => a - b)[0]
assert.ok(Number.isFinite(first))
const windows = [{ name: 'idle', start: first - 10800000, end: first - 7200000 },
  { name: 'live', start: first + 600000, end: first + 2400000 }]
const evidence = path.join(miniRoot, 'evidence')
await mkdir(evidence, { recursive: true })
const requests = path.join(evidence, `l4c-${label}-requests.jsonl`)
await writeFile(requests, '')
const previous = JSON.parse(await sql(`SELECT coalesce(jsonb_agg(setting),'[]') FROM pg_db_role_setting,
  LATERAL unnest(setconfig) setting WHERE setting LIKE 'pgrst.db_pre_request=%'`))
assert.ok(previous.length === 0 || previous.every(value => value === 'pgrst.db_pre_request=perf_lab.tag_job'), 'Preserve an existing request hook')
await sql("ALTER SYSTEM SET track_functions='all'")
await sql("ALTER SYSTEM SET log_min_duration_statement='-1'")
await sql("ALTER SYSTEM SET log_parameter_max_length='0'")
await sql("ALTER SYSTEM SET log_parameter_max_length_on_error='0'")
await sql("ALTER SYSTEM SET log_line_prefix='%m [%p] %a %u@%d '")
await sql('SELECT pg_reload_conf()')
await sql(await readFile('tests/perf-l4c/metrics-setup.sql', 'utf8'))
for (const window of windows) {
  await sql(`INSERT INTO perf_lab.metrics_boundaries VALUES('${window.name}','before','${new Date(window.start).toISOString()}'),
    ('${window.name}','after','${new Date(window.end).toISOString()}')`)
}
const costs = [], boundaries = []
let carry = ''
const logs = spawn('docker', ['logs', '--follow', '--since', new Date().toISOString(), config.container], { stdio: ['ignore', 'pipe', 'pipe'] })
const consume = bytes => {
  carry += bytes.toString()
  for (;;) {
    const end = carry.indexOf('\n')
    if (end < 0) return
    const line = carry.slice(0, end)
    carry = carry.slice(end + 1)
    const marker = line.indexOf('L4C_BOUNDARY ')
    if (marker >= 0) boundaries.push(JSON.parse(line.slice(marker + 13)))
    const match = line.match(/l4c:(idle|live):([a-z0-9-]+).*duration:\s*([\d.]+) ms/)
    if (match && !line.includes('tag_job')) costs.push({ window: match[1], job: match[2], ms: Number(match[3]) })
  }
}
logs.stdout.on('data', consume)
logs.stderr.on('data', consume)
let exitCode
try {
  const child = spawn(process.execPath, ['tests/perf-l4c/replay.mjs'], { env: {
    ...process.env, PERF_LAB_CAPTURE_PROFILE: 'control', L4C_WINDOWS: JSON.stringify(windows), L4C_REQUESTS: requests,
    SEASON_SIM_EDGE_ENTRYPOINT: 'tests/perf-l4c/edge-metrics.mjs',
    SEASON_SIM_PSQL: path.join(process.cwd(), 'tests/perf-l4c/metrics-psql.mjs'),
    ...(reference ? { SEASON_SIM_FUNCTIONS_ROOT: functions } : {}),
  }, stdio: 'inherit' })
  ;[exitCode] = await once(child, 'exit')
} finally {
  if (logs.exitCode === null) { const closed = once(logs, 'close'); logs.kill('SIGTERM'); await closed }
  await sql('ALTER ROLE authenticator RESET pgrst.db_pre_request')
  await sql("NOTIFY pgrst,'reload config'")
}
const lines = (await readFile(requests, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const edgeJobs = { 'live-poll': 'live-poll', 'stats-sync': 'sync-stats', 'sync-scores': 'sync-scores',
  'sync-players': 'sync-players', 'sync-player-injuries': 'sync-player-injuries',
  'sleeper-projections': 'sync-sleeper-projections', 'fantasypros-projections': 'sync-projections' }
const sqlJobs = { 'setup-season-rollover': 'roll_setup_league_seasons', 'public-read-retention': 'public_prune_read_log',
  'edge-invocation-reconcile': 'reconcile_edge_invocations' }
const rows = windows.map(window => {
  const factor = 3600000 / (window.end - window.start)
  const pair = boundaries.filter(row => row.name === window.name)
  const before = pair.find(row => row.phase === 'before')
  const after = pair.find(row => row.phase === 'after')
  const complete = !!before && !!after && pair.every(row => Date.parse(row.expectedAt) === Date.parse(row.at))
  const jobs = Object.fromEntries(Object.entries(edgeJobs).map(([name, job]) => [name,
    edgeWindowCosts(lines, costs, window.name, job, factor)]))
  for (const [name, fn] of Object.entries(sqlJobs)) {
    const b = before?.functions.find(row => row.name === fn) ?? { calls: 0, ms: 0 }
    const a = after?.functions.find(row => row.name === fn) ?? { calls: 0, ms: 0 }
    jobs[name] = { callsPerHour: (a.calls - b.calls) * factor, databaseMsPerHour: (a.ms - b.ms) * factor }
  }
  jobs['pg-net-response-vacuum'] = { callsPerHour: ((after?.vacuum.calls ?? 0) - (before?.vacuum.calls ?? 0)) * factor,
    databaseMsPerHour: ((after?.vacuum.ms ?? 0) - (before?.vacuum.ms ?? 0)) * factor }
  return { ...window, complete, jobs }
})
await writeFile(path.join(evidence, `l4c-${label}-costs.json`), `${JSON.stringify({ label, applicationCommit, exitCode, windows: rows, boundaries, costs }, null, 2)}\n`)
assert.equal(exitCode, 0, 'The measured replay must pass')
assert.ok(rows.every(row => row.complete), 'Both cost windows must be complete')
console.log(JSON.stringify(rows))
