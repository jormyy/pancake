import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export async function runCalendarRed() {
  const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(), path.join(lane, 'repo'))
  const db = 'postgresql://postgres:postgres@127.0.0.1:57422/postgres'
  assert.equal(new URL(db).hostname, '127.0.0.1'); assert.equal(new URL(db).port, '57422')
  const evidence = path.join(lane, 'evidence/review7')
  const sql = statement => execFileSync('psql', [db, '-XqAtv', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' }).trim()
  const definition = () => sql("SELECT pg_get_functiondef('public.publish_nba_schedule_atomic(integer,jsonb,jsonb)'::regprocedure)")
  const hash = value => createHash('sha256').update(value).digest('hex')
  const files = ['schedule', 'nba'].map(name => ({ file: `supabase/functions/_shared/${name}.ts`, base: path.join(evidence, `base-${name}.ts`) }))
  files.push({ file: 'supabase/functions/_shared/seasonBoundary.ts', base: path.join(evidence, 'base-boundary.ts') })
  const originals = files.map(file => readFileSync(file.file, 'utf8'))
  const originalSql = definition()
  const rows = []
  const run = (name, file, expected, extra) => {
    const start = performance.now()
    const result = spawnSync('node', ['scripts/mutation/post/check.mjs', file], { env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
    const command = `node scripts/mutation/post/check.mjs ${file}`
    const log = path.join(evidence, `${name}.log`)
    writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`)
    rows.push({ name, command, env: extra, exit: result.status, seconds: Math.round((performance.now()-start)/10)/100, expected, log })
    writeFileSync(path.join(evidence, 'final-red-green.json'), JSON.stringify(rows,null,2)+'\n')
    console.log(JSON.stringify(rows.at(-1)))
    assert.equal(result.status, expected, log)
  }
  try {
    for (const file of files) writeFileSync(file.file, readFileSync(file.base, 'utf8'))
    sql(readFileSync(path.join(evidence, 'base-publish.sql'), 'utf8'))
    for (const testCase of ['opening', 'all-star', 'postponed-status']) run(`final-red-${testCase}`, 'supabase/tests/db/calendar-seasons.ts', 1, { POST_CALENDAR_CASE: testCase })
    run('final-base-cup', 'supabase/tests/db/calendar-seasons.ts', 0, { POST_CALENDAR_CASE: 'cup' })
    for (const testCase of ['durable', 'outside']) run(`final-red-${testCase}`, 'supabase/tests/db/calendar-ingestion.ts', 3, { POST_CALENDAR_CASE: testCase })
    for (const testCase of ['missing', 'published']) run(`final-red-${testCase}`, 'supabase/tests/db/calendar-publish.ts', 3, { POST_CALENDAR_CASE: testCase })
    run('final-red-boundary-recheck', 'supabase/tests/db/playoff-stale-boundary.ts', 1, { POST_STALE_CASE: 'bracket_unavailable_recheck' })
    run('final-red-boundary', 'supabase/tests/db/playoff-stale-boundary.ts', 1, { POST_STALE_CASE: 'bracket_unavailable' })
  } finally {
    for (const [index, file] of files.entries()) { writeFileSync(file.file, originals[index]); assert.equal(hash(readFileSync(file.file, 'utf8')), hash(originals[index])) }
    sql(originalSql); assert.equal(hash(definition()), hash(originalSql))
    writeFileSync(path.join(evidence, 'red-restore.json'), JSON.stringify({ files: files.map((file,index) => ({ file: file.file, before: hash(originals[index]), restored: hash(readFileSync(file.file,'utf8')) })), sql: { before: hash(originalSql), restored: hash(definition()) } }, null, 2)+'\n')
  }
  run('final-green-boundary-recheck', 'supabase/tests/db/playoff-stale-boundary.ts', 0, { POST_STALE_CASE: 'bracket_unavailable_recheck' })
  run('final-green-boundary', 'supabase/tests/db/playoff-stale-boundary.ts', 0, { POST_STALE_CASE: 'bracket_unavailable' })
  run('final-green-calendar', 'supabase/tests/db/calendar-seasons.ts', 0, {})
}
