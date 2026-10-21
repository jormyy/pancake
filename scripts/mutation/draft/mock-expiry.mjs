import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from './clock-stack.mjs'

const root = resolve(process.env.DRAFT_MUTATION_EVIDENCE_DIR ?? 'evidence/t9/mutation')
mkdirSync(root, { recursive: true })
const file = 'supabase/migrations/20261020000260_mock_room_deadline_retention.sql'
const symbol = 'public.expire_mock_draft_rooms()'
const cases = [
  { id: 'mock-expiry-start-anchor', original: 'SELECT pick.timer_expires_at', mutated: 'SELECT draft.started_at', operator: 'column swap: current pick deadline -> draft start' },
  { id: 'mock-expiry-paused-subtraction', original: '+ make_interval(secs => draft.timer_paused_remaining_seconds)', mutated: '- make_interval(secs => draft.timer_paused_remaining_seconds)', operator: 'arithmetic + -> - saved paused seconds' },
  { id: 'mock-expiry-inclusive-boundary', original: 'draft.created_at\n         ) < now()', mutated: 'draft.created_at\n         ) <= now()', operator: 'relational < -> <= active retention boundary' },
]
const hash = value => createHash('sha256').update(value).digest('hex')
function oracle(name) {
  const command = ['node', 'tests/db/draft-mock-expiry.mjs']
  const start = performance.now()
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', env: { ...process.env, DRAFT_CLOCK_EVIDENCE_DIR: resolve(root, name) }, timeout: 120000, maxBuffer: 1024 * 1024 })
  const log = resolve(root, `${name}.log`)
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  const value = { name, command: command.join(' '), exit: result.status ?? 124, seconds: Number(((performance.now() - start) / 1000).toFixed(3)), log }
  console.log(JSON.stringify(value))
  return value
}
assert.equal(oracle('baseline').exit, 0)
for (const item of cases) {
  const original = sql(`SELECT pg_get_functiondef('${symbol}'::regprocedure)`)
  let applied = false, outcome = 'invalid', notes = '', oracles = []
  try {
    assert.equal(original.split(item.original).length, 2, 'Each operator must change exactly one application expression')
    sql(original.replace(item.original, item.mutated))
    applied = true
    const result = oracle(item.id)
    oracles = [result]
    outcome = result.exit === 124 ? 'timeout' : result.exit === 0 ? 'survived' : 'killed'
    notes = outcome === 'killed' ? 'The real room RPC setup succeeds; the cleanup retention assertion fails.' : 'Requires classification.'
  } catch (error) {
    notes = String(error)
  } finally {
    sql(original)
    const restored = hash(sql(`SELECT pg_get_functiondef('${symbol}'::regprocedure)`))
    assert.equal(restored, hash(original))
    console.log(JSON.stringify({ id: item.id, originalSha256: hash(original), restoredSha256: restored }))
  }
  const source = readFileSync(file, 'utf8')
  const line = source.slice(0, source.indexOf(item.original)).split('\n').length
  appendFileSync(resolve(root, 'results.jsonl'), JSON.stringify({ id: item.id, area: 'draft-timer', file, line, symbol, operator: item.operator, original: item.original, mutated: item.mutated, applied, outcome, oracles, killed_by: outcome === 'killed' ? oracles.map(value => value.name) : [], notes }) + '\n')
  assert.equal(outcome, 'killed')
}
assert.equal(oracle('restored').exit, 0)
