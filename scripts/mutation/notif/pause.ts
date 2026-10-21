import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const db = Deno.env.get('SUPABASE_DB_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
const evidence = Deno.env.get('NOTIF_EVIDENCE')!
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(Deno.cwd() + '/'))
function sql(source: string) {
  const result = spawnSync('psql', [db, '-XqAtv', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
const quote = (source: string) => `'${source.replaceAll("'", "''")}'`
const windowCommand = ['psql', db, '-Xv', 'ON_ERROR_STOP=1', '-f', 'tests/db/notif-pause-window.sql']
const wakeCommand = ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-read', '--allow-net=127.0.0.1,0.0.0.0', '--allow-run=psql,docker', 'supabase/tests/db/notif-pause-resume.ts']
function oracle(name: string, command: string[]) {
  const started = performance.now()
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 120000, env: { ...Deno.env.toObject(), NOTIF_PAUSE_SKIP_CRON: '1' } })
  const log = path.join(evidence, name + '.log')
  writeFileSync(log, result.stdout + result.stderr)
  const record = { name, command, exit: result.status ?? -1, seconds: (performance.now() - started) / 1000, log }
  appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify(record) + '\n')
  console.log(JSON.stringify(record))
  return record
}
const mutants = [
  { id: 'N33', symbol: 'private.notif_is_stale(text,jsonb)', original: "IF d.status = 'paused' THEN RETURN false;", mutated: "IF d.status = 'paused' THEN RETURN true;", operator: 'terminally suppress temporary pause', command: windowCommand },
  { id: 'N34', symbol: 'private.notif_draft_trigger()', original: "PERFORM public.invoke_edge_function('process-trades');", mutated: 'PERFORM 1;', operator: 'remove immediate resume wake', command: wakeCommand },
  { id: 'N35', symbol: 'private.notif_draft_deferred_until(text,jsonb)', original: "IF deadline>clock_timestamp()+interval '1 minute' THEN RETURN deadline-interval '1 minute';", mutated: "IF false THEN RETURN deadline-interval '1 minute';", operator: 'remove resumed expiry window deferral', command: windowCommand },
]
for (const [name, command] of [['window', windowCommand], ['wake', wakeCommand]] as const) assert.equal(oracle('r3i-mutation-baseline-' + name, command).exit, 0)
const migration = 'supabase/migrations/20261020000179_notification_pause_deferral.sql'
let killed = 0
for (const mutant of mutants) {
  const definition = sql(`SELECT pg_get_functiondef(${quote(mutant.symbol)}::regprocedure)`)
  assert.equal(definition.split(mutant.original).length, 2)
  let applied = false
  let result: ReturnType<typeof oracle> | undefined
  try {
    sql(definition.replace(mutant.original, mutant.mutated))
    applied = true
    assert.notEqual(hash(sql(`SELECT pg_get_functiondef(${quote(mutant.symbol)}::regprocedure)`)), hash(definition))
    result = oracle('r3i-mutation-' + mutant.id, mutant.command)
  } finally {
    sql(definition)
    assert.equal(hash(sql(`SELECT pg_get_functiondef(${quote(mutant.symbol)}::regprocedure)`)), hash(definition))
  }
  assert.ok(result)
  const outcome = result.exit === 0 ? 'survived' : result.exit === -1 ? 'timeout' : 'killed'
  if (outcome === 'killed') killed++
  const line = readFileSync(migration, 'utf8').split('\n').findIndex(source => source.includes('FUNCTION ' + mutant.symbol.split('(')[0] + '(')) + 1
  appendFileSync(path.join(evidence, 'results.jsonl'), JSON.stringify({ id: mutant.id, area: 'notifications', file: migration, line, symbol: mutant.symbol, operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, applied, outcome, oracles: [result], killed_by: outcome === 'killed' ? [result.name] : [], notes: 'Actual deployed SQL overlay; pg_get_functiondef hash restored before the next mutant.' }) + '\n')
  assert.equal(oracle('r3i-mutation-restored-' + mutant.id, mutant.command).exit, 0)
}
console.log(JSON.stringify({ total: mutants.length, killed, survived: mutants.length - killed, invalid: 0, timeout: 0, equivalent: 0 }))
assert.equal(killed, mutants.length)
