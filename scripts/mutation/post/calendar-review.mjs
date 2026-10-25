import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export async function runCalendarReview() {
  const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(), path.join(lane, 'repo'))
  const evidence = path.join(lane, 'evidence/review7')
  mkdirSync(evidence, { recursive: true })
  const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const keys = Object.fromEntries(status.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')] }))
  for (const [target, port] of [[keys.API_URL, '57421'], [keys.DB_URL, '57422']]) {
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
    assert.equal(new URL(target).port, port)
  }
  const env = { ...process.env, SUPABASE_URL: keys.API_URL, SUPABASE_DB_URL: keys.DB_URL, E2E_SUPABASE_URL: keys.API_URL,
    PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, E2E_PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_ANON_KEY: keys.ANON_KEY,
    E2E_SUPABASE_PUBLISHABLE_KEY: keys.PUBLISHABLE_KEY ?? keys.ANON_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
    PANCAKE_TEST_API_PORT: '57421', PANCAKE_TEST_DB_PORT: '57422' }
  for (const key of ['POST_CALENDAR_CASE', 'POST_STALE_CASE', 'POST_SKIP_PHASE', 'POST_ROOKIE_CASE']) delete env[key]
  const calendarOnly = process.argv.includes('--calendar-only')
  const prefix = calendarOnly ? 'final-' : ''
  const rows = []
  const run = (name, binary, args, extra = {}) => {
    const start = performance.now()
    const result = spawnSync(binary, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
    const log = path.join(evidence, `${prefix}${name}.log`)
    writeFileSync(log, `${binary} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status} signal=${result.signal}\n`)
    const row = { name, command: `${binary} ${args.join(' ')}`, env: extra, exit: result.status, seconds: Math.round((performance.now()-start)/10)/100, log }
    rows.push(row); writeFileSync(path.join(evidence, calendarOnly ? 'final-commands.json' : 'commands.json'), JSON.stringify(rows, null, 2)+'\n'); console.log(JSON.stringify(row))
    assert.equal(result.status, 0, log)
  }
  for (let pass = 1; pass <= 2; pass++) {
    run(`pass${pass}-calendar-seasons`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/calendar-seasons.ts'])
    for (const testCase of ['durable', 'outside', 'cross-week']) run(`pass${pass}-${testCase}`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/calendar-ingestion.ts'], { POST_CALENDAR_CASE: testCase })
    for (const testCase of ['missing', 'published', 'contract']) run(`pass${pass}-${testCase}`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/calendar-publish.ts'], { POST_CALENDAR_CASE: testCase })
    run(`pass${pass}-real-makeups`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/calendar-real-makeups.ts'])
    run(`pass${pass}-stale-boundary`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/playoff-stale-boundary.ts'])
  }
  if (calendarOnly) return
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith('test:db:') && /playoff-|season-boundary-|three-season|postponed-score|postponed-scoring|shared-nba-calendar|game-calendar-corrections/.test(String(command))) run(name.replaceAll(':','-'), 'npm', ['run',name])
  }
  run('rookie-skipped-week', 'npm', ['run', 'evidence:db:rookie-skipped-week'])
  run('deadline-locks', 'npm', ['run', 'test:db:deadline-locks'])
  run('season-boundary-units', 'deno', ['test','--no-lock','--allow-env','--allow-read','--allow-net=127.0.0.1,localhost', 'supabase/functions/_shared/seasonBoundaryCalendar.test.ts','supabase/functions/_shared/seasonBoundaryFailures.test.ts','supabase/functions/_shared/octoberGap.test.ts'])
}
