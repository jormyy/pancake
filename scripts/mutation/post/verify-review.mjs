import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const lane = resolve(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), resolve(lane, 'repo'))
const db = 'postgresql://postgres:postgres@127.0.0.1:57422/postgres'
assert.equal(new URL(db).hostname, '127.0.0.1')
assert.equal(new URL(db).port, '57422')
const evidence = resolve(lane, 'evidence')
for (const folder of ['red', 'green', 'review2']) mkdirSync(`${evidence}/${folder}`, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const sql = source => {
  const result = spawnSync('psql', [db, '-XqAtv', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const functions = [
  ['advance_season_atomic', 'uuid'],
  ['auto_pick_snake_pick_atomic', 'uuid,uuid,text,boolean'],
  ['invoke_season_boundary_if_due', 'timestamp with time zone'],
]
for (const [name] of functions) sql(readFileSync(`supabase/sql/functions/by-name/public/${name}.sql`, 'utf8'))
const check = (file, test, expected, selectedCase) => {
  const command = test.endsWith('.sql') || test.endsWith('.ts') ? ['node', 'scripts/mutation/post/check.mjs', test] : ['node', test, '--check']
  const result = spawnSync(command[0], command.slice(1), { env: { ...process.env, ...(selectedCase ? { POST_ROOKIE_CASE: selectedCase } : {}) }, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(`${evidence}/${file}`, `${selectedCase ? `POST_ROOKIE_CASE=${selectedCase} ` : ''}${command.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`)
  assert.equal(result.status, expected, `${file}: ${result.stderr || result.stdout}`)
  console.log(`${file} exit=${result.status}`)
}
check('review2/function-sources.log', 'scripts/check-db-function-sources.mjs', 0)
for (const file of ['tests/db/rollover-year-gap.sql', 'tests/db/picks-lifecycle.sql', 'tests/db/dynasty-rules.sql', 'tests/db/rookie-drafting-gate.sql', 'supabase/tests/db/rookie-backstop.ts']) {
  check(`green/${file.split('/').at(-1).replace(/\.(sql|ts)$/, '')}-review2.log`, file, 0)
}
const target = 'supabase/functions/_shared/seasonBoundary.ts'
const before = readFileSync(target, 'utf8')
const fixtureHash = hash(readFileSync('supabase/tests/db/rookie-backstop.ts', 'utf8'))
const previous = functions.slice(1).map(([name, signature]) => ({ name, signature, source: sql(`SELECT pg_get_functiondef('public.${name}(${signature})'::regprocedure);`) }))
const base = resolve(homedir(), 'pancake-t_4ba51e0d/base')
const baseModule = readFileSync(`${base}/${target}`, 'utf8')
assert.ok(baseModule.includes(".in('leagues.status', ['active', 'playoffs', 'offseason'])"))
const proof = { provenance: 'SYNTHETIC', base: '10281afb7e95cb434fbe55046e0f8ee774bbda21', fixture: fixtureHash, fixedModule: hash(before), baseModule: hash(baseModule), restore: {} }
try {
  writeFileSync(target, baseModule)
  for (const { name } of previous) sql(readFileSync(`${base}/supabase/sql/functions/by-name/public/${name}.sql`, 'utf8'))
  check('red/rookie-backstop-final.log', 'supabase/tests/db/rookie-backstop.ts', 1)
  check('review2/auction-base.log', 'supabase/tests/db/rookie-backstop.ts', 0, 'auction')
  check('review2/commissioner-early-base.log', 'supabase/tests/db/rookie-backstop.ts', 0, 'commissioner_early')
  check('red/rookie-drafting-gate-base.log', 'tests/db/rookie-drafting-gate.sql', 3)
} finally {
  writeFileSync(target, before)
  assert.equal(hash(readFileSync(target, 'utf8')), hash(before))
  proof.restore[target] = hash(before)
  for (const { name, signature, source } of previous) {
    sql(source)
    const restored = sql(`SELECT pg_get_functiondef('public.${name}(${signature})'::regprocedure);`)
    assert.equal(hash(restored), hash(source))
    proof.restore[name] = hash(restored)
  }
  assert.equal(hash(readFileSync('supabase/tests/db/rookie-backstop.ts', 'utf8')), fixtureHash)
  writeFileSync(`${evidence}/review2/base-restore.json`, JSON.stringify(proof, null, 2) + '\n')
}
check('green/rookie-backstop-final.log', 'supabase/tests/db/rookie-backstop.ts', 0)
check('green/rookie-drafting-gate-final.log', 'tests/db/rookie-drafting-gate.sql', 0)
