import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const db = Deno.env.get('SUPABASE_DB_URL')!, evidence = Deno.env.get('NOTIF_EVIDENCE')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(Deno.cwd() + '/'))
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function sql(source: string) {
  const result = spawnSync('psql', [db, '-XqAtv', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function oracle(label: string, recipe: string) {
  const command = ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-read', '--allow-write', '--allow-net=127.0.0.1', '--allow-run=psql', `supabase/tests/db/notif-t9-${recipe}.ts`]
  const start = performance.now()
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 180000 })
  const log = path.join(evidence, label + '.log')
  writeFileSync(log, result.stdout + result.stderr)
  const record = { name: label, command, exit: result.status ?? -1, seconds: (performance.now() - start) / 1000, log }
  appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify(record) + '\n')
  console.log(JSON.stringify(record))
  return record
}
const mutants = [
  { id: 'N51', symbol: 'private.notif_draft_audit_trigger()', original: "OR NEW.metadata->>'reason'='member_absent_rejoined'", mutated: '', operator: 'remove absence-rejoin resume branch', recipe: 'draft' },
  { id: 'N52', symbol: 'private.notif_draft_audit_trigger()', original: "OR NEW.metadata->>'reason'='member_absent_rejoined'", mutated: "AND NEW.metadata->>'reason'='member_absent_rejoined'", operator: 'require both disjoint resume metadata formats', recipe: 'draft' },
]
for (const recipe of new Set(mutants.map(mutant => mutant.recipe))) assert.equal(oracle('f1-mutation-baseline-' + recipe, recipe).exit, 0)
const outcomes: Record<string, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0, equivalent: 0 }
for (const mutant of mutants) {
  const definition = sql(`SELECT pg_get_functiondef(${q(mutant.symbol)}::regprocedure)`)
  let applied = false, outcome = 'invalid', notes = ''
  const oracles: ReturnType<typeof oracle>[] = []
  let file = '', line = 0
  for (const name of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
    const source = readFileSync('supabase/migrations/' + name, 'utf8')
    const index = source.toLowerCase().indexOf('create or replace function ' + mutant.symbol.split('(')[0].toLowerCase() + '(')
    if (index >= 0) { file = 'supabase/migrations/' + name; line = source.slice(0, index).split('\n').length }
  }
  try {
    assert.ok(file && line)
    assert.equal(definition.split(mutant.original).length, 2, 'Operator must apply exactly once')
    sql(definition.replace(mutant.original, mutant.mutated))
    applied = true
    assert.notEqual(hash(sql(`SELECT pg_get_functiondef(${q(mutant.symbol)}::regprocedure)`)), hash(definition))
    const result = oracle('f1-mutation-' + mutant.id, mutant.recipe)
    oracles.push(result)
    outcome = result.exit === 0 ? 'survived' : result.exit === -1 ? 'timeout' : 'killed'
  } catch (error) { notes = String(error) }
  finally {
    sql(definition)
    const restored = hash(sql(`SELECT pg_get_functiondef(${q(mutant.symbol)}::regprocedure)`))
    assert.equal(restored, hash(definition))
    notes += ` Original and restored pg_get_functiondef SHA256: ${restored}.`
  }
  outcomes[outcome]++
  const record = { id: mutant.id, area: 'notifications', file, line, symbol: mutant.symbol, operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, applied, outcome, oracles, killed_by: outcome === 'killed' ? oracles.map(result => result.name) : [], notes }
  for (const target of [path.join(evidence, 'results.jsonl'), path.join(evidence, '..', 'results.jsonl')]) appendFileSync(target, JSON.stringify(record) + '\n')
  assert.equal(oracle('f1-mutation-restored-' + mutant.id, mutant.recipe).exit, 0)
}
console.log(JSON.stringify({ total: mutants.length, ...outcomes }))
assert.equal(outcomes.killed, mutants.length)
