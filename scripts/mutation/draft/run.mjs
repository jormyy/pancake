import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.env.DRAFT_MUTATION_EVIDENCE_DIR ?? 'evidence')
mkdirSync(root, { recursive: true })
const keys = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
const target = new URL(keys.DB_URL)
assert(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === '57922')
const sql = statement => execFileSync('psql', [keys.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' }).trim()
const digest = value => createHash('sha256').update(value).digest('hex')
const targets = [
  { id: 'timer-min', symbol: 'public.start_rookie_draft_atomic(uuid,integer,boolean,integer,text)', file: 'supabase/migrations/20261020000202_draft_arm_after_lock.sql', original: 'p_pick_timer_seconds < 60', mutated: 'p_pick_timer_seconds < 59', operator: 'boundary constant 60 -> 59', oracle: 'tests/db/draft-timer-range.sql' },
  { id: 'timer-max', symbol: 'public.start_rookie_draft_atomic(uuid,integer,boolean,integer,text)', file: 'supabase/migrations/20261020000202_draft_arm_after_lock.sql', original: 'p_pick_timer_seconds > 604800', mutated: 'p_pick_timer_seconds > 604801', operator: 'boundary constant 604800 -> 604801', oracle: 'tests/db/draft-timer-range.sql' },
  { id: 'cutoff-equality', symbol: 'private.draft_timer_complete_opening_night(integer,timestamp with time zone)', file: 'supabase/migrations/20261020000201_draft_cutoff_atomic_results.sql', original: '<= p_at', mutated: '< p_at', operator: 'relational <= -> <', oracle: 'tests/db/draft-timer-behavior.sql' },
  { id: 'pause-rounding', symbol: 'public.pause_draft_atomic(uuid,uuid)', file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int', mutated: 'CEIL(EXTRACT(EPOCH FROM (timer_expires_at - v_now)))::int + 1', operator: 'arithmetic off-by-one + 1 second', oracle: 'tests/db/draft-timer-pause.sql' },
  { id: 'warning-multiply', symbol: 'public.draft_timer_start_warning(uuid,integer,integer)', file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'v_picks::double precision * p_pick_timer_seconds', mutated: 'v_picks::double precision + p_pick_timer_seconds', operator: 'arithmetic * -> +', oracle: 'tests/db/draft-timer-behavior.sql' },
  { id: 'warning-comparison', symbol: 'public.draft_timer_start_warning(uuid,integer,integer)', file: 'supabase/migrations/20261020000200_rookie_draft_long_timers.sql', original: 'v_finish >= v_cutoff', mutated: 'v_finish < v_cutoff', operator: 'relational >= -> <', oracle: 'tests/db/draft-timer-behavior.sql' },
  { id: 'mock-max', symbol: 'public.create_mock_draft_room_atomic(uuid,uuid,uuid,text,text,timestamp with time zone,text,integer,integer,integer,text)', file: 'supabase/migrations/20261020000204_mock_rookie_timer_range.sql', original: 'v_timer_seconds > 604800', mutated: 'v_timer_seconds >= 604800', operator: 'relational > -> >= (mock upper bound)', oracle: 'tests/db/draft-timer-mock.sql' },
].filter(target => !process.argv[2] || target.id === process.argv[2])
assert(targets.length > 0, 'Unknown mutant')
const oracle = (file, name) => {
  const command = `node scripts/mutation/draft/check.mjs ${file}`
  const start = performance.now()
  const result = spawnSync('node', ['scripts/mutation/draft/check.mjs', file], { encoding: 'utf8', timeout: 30000 })
  const log = resolve(root, `${name}.log`)
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`)
  return { name, command, exit: result.status ?? 124, seconds: Number(((performance.now()-start)/1000).toFixed(3)), log }
}
for (const file of new Set(targets.map(target => target.oracle))) {
  const baseline = oracle(file, `baseline-${file.split('/').at(-1)}`)
  console.log(JSON.stringify(baseline))
  assert.equal(baseline.exit, 0, 'The exact oracle must pass before mutation')
}
for (const item of targets) {
  const original = sql(`SELECT pg_get_functiondef('${item.symbol}'::regprocedure);`)
  assert(original.includes(item.original))
  const mutated = original.replace(item.original, item.mutated)
  let applied = false
  let outcome = 'invalid'
  const oracles = []
  let notes = ''
  try {
    sql(mutated)
    applied = true
    const result = oracle(item.oracle, item.id)
    oracles.push(result)
    outcome = result.exit === 124 ? 'timeout' : result.exit === 0 ? 'survived' : 'killed'
    notes = outcome === 'killed' ? 'Behavioral assertion fails; the fixture setup stays valid.' : 'Requires classification.'
  } catch (error) { notes = String(error) }
  finally {
    sql(original)
    assert.equal(digest(sql(`SELECT pg_get_functiondef('${item.symbol}'::regprocedure);`)), digest(original), 'Restored definition must match exactly')
  }
  const source = readFileSync(item.file, 'utf8')
  const symbolStart = source.indexOf(`CREATE OR REPLACE FUNCTION ${item.symbol.split('(')[0]}(`)
  const line = source.slice(0, source.indexOf(item.original, symbolStart)).split('\n').length
  const record = { id: item.id, area: 'draft-timer', file: item.file, line, symbol: item.symbol, operator: item.operator, original: item.original, mutated: item.mutated, applied, outcome, oracles, killed_by: outcome === 'killed' ? oracles.map(result => result.name) : [], notes }
  appendFileSync(resolve(root, 'results.jsonl'), `${JSON.stringify(record)}\n`)
  console.log(`${item.id}: ${outcome}`)
}
for (const file of new Set(targets.map(target => target.oracle))) assert.equal(oracle(file, `restored-${file.split('/').at(-1)}`).exit, 0)
