import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { lane } from './lane.mjs'
import { restartEdge, servedFileSha } from './edge.mjs'

// Current-head reruns of changed post targets (common-t10 protocol). The plan
// comes from t10-scan.py, or from t11-plan.py with POST_PLAN. Usage:
//   node scripts/mutation/post/rerun-t10.mjs --baseline
//   node scripts/mutation/post/rerun-t10.mjs [id|area|sql|ts ...]
// Every oracle in the selection first runs once on the unmutated build; a
// mutant counts as killed only when an oracle fails behaviorally. Each target
// is restored and hash-verified before the next mutant; served-path mutants
// restart the real Edge runtime after the mutation and after the restore (a SQL
// overlay is live in the database without a restart).
const plan = JSON.parse(readFileSync(process.env.POST_PLAN ?? 'scripts/mutation/post/t10-plan.json', 'utf8'))
const evidence = process.env.POST_EVIDENCE ?? resolve(lane, 'evidence/t10')
assert.ok(evidence.startsWith(`${lane}/evidence/`))
mkdirSync(`${evidence}/logs`, { recursive: true })
const db = 'postgresql://postgres:postgres@127.0.0.1:57422/postgres'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, '57422')
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')] }))
assert.equal(new URL(keys.API_URL).port, '57421')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(keys.API_URL).hostname))
const env = { ...process.env, PANCAKE_TEST_API_PORT: '57421', PANCAKE_TEST_DB_PORT: '57422', SUPABASE_DB_URL: db, SUPABASE_URL: keys.API_URL, SUPABASE_ANON_KEY: keys.ANON_KEY, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token' }
const sql = statement => {
  const result = spawnSync('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  return result.stdout.trim()
}
const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "''")}'`
const definition = symbol => sql(`SELECT pg_get_functiondef(${quote(symbol)}::regprocedure);`)
const deployedBody = symbol => sql(`SELECT prosrc FROM pg_proc WHERE oid=${quote(symbol)}::regprocedure;`)
const migrationBody = (file, symbol) => {
  const text = readFileSync(file, 'utf8')
  const [schema, name] = symbol.split('(')[0].split('.')
  const starts = [...text.matchAll(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+"?${schema}"?\\."?${name}"?\\s*\\(`, 'gi'))]
  const start = text.indexOf('$$', starts.at(-1).index) + 2
  return text.slice(start, text.indexOf('$$;', start)).trim()
}
const kindRank = ['unit', 'ts-module-db', 'db-deployed', 'edge-http']
const compileFailure = /error: TS\d+|Type checking failed|error: Uncaught \(in promise\) TypeError: Module not found|SyntaxError:|error: The module's source code could not be parsed/
// A signal-terminated oracle (check.mjs reports `exit=null … signal=SIG…` and exits 125) ran no assertion.
const crashed = (exit, output) => exit === 125 || exit > 128 || /^exit=null .*signal=SIG\w+/m.test(output)

const selection = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const selected = plan.mutants.filter(mutant => selection.length === 0 || selection.includes(mutant.id) || selection.includes(mutant.area) || selection.includes(mutant.kind))
assert.ok(selected.length, 'No mutant matches the selection')
const usesHttp = mutant => mutant.kind === 'ts' && mutant.oracles.some(name => plan.oracles[name].kind === 'edge-http')

const runOracle = (name, prefix) => {
  const oracle = plan.oracles[name]
  const log = `${evidence}/logs/${prefix}-${name}.log`
  const started = performance.now()
  const result = spawnSync('/bin/sh', ['-c', oracle.command], { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
  const errorCode = result.error && 'code' in result.error ? result.error.code : ''
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(log, `${oracle.command}\n${output}\nexit=${result.status} signal=${result.signal} error=${errorCode}\n`)
  const exit = errorCode === 'ETIMEDOUT' ? 124 : result.status ?? 125
  const evidenceLine = output.split('\n').find(line => /AssertionError|Error:|ERROR:|FAIL|assert/i.test(line))?.trim().slice(0, 240) ?? ''
  return { name, exit, seconds: Math.round((performance.now() - started) / 10) / 100, log, compile: exit !== 0 && compileFailure.test(output), crash: exit !== 0 && exit !== 124 && crashed(exit, output), evidenceLine }
}

// Served-path oracles need the real Edge runtime to load the unmutated source first.
if (selected.some(usesHttp)) {
  await restartEdge()
  for (const file of new Set(selected.filter(usesHttp).map(mutant => mutant.file))) assert.equal(servedFileSha(file), hash(readFileSync(file)))
}
for (const mutant of selected) {
  if (mutant.kind === 'ts') assert.equal(hash(readFileSync(mutant.file)), mutant.source_sha256, `${mutant.file} is not the ${plan.base_sha} source`)
  else assert.equal(deployedBody(mutant.symbol), migrationBody(mutant.file, mutant.symbol), `${mutant.symbol} is not deployed from ${mutant.file}`)
}
const names = [...new Set(selected.flatMap(mutant => mutant.oracles))]
const baseline = Object.fromEntries(names.map(name => [name, runOracle(name, 'baseline')]))
writeFileSync(`${evidence}/baseline-${Date.now()}.jsonl`, Object.values(baseline).map(result => JSON.stringify(result)).join('\n') + '\n')
const failing = Object.values(baseline).filter(result => result.exit !== 0)
assert.equal(failing.length, 0, `Baseline fails: ${failing.map(result => result.log).join(', ')}`)
if (process.argv.includes('--baseline')) process.exit(0)

for (const mutant of selected) {
  const isTypeScript = mutant.kind === 'ts'
  const http = usesHttp(mutant)
  const readDefinition = () => isTypeScript ? readFileSync(mutant.file, 'utf8') : definition(mutant.symbol)
  const applyDefinition = value => isTypeScript ? writeFileSync(mutant.file, value) : sql(value)
  const row = {
    id: mutant.id, lane: 'post', area: mutant.area, file: mutant.file, line: mutant.line, symbol: mutant.symbol,
    operator: mutant.operator, original: mutant.original, mutated: mutant.mutated,
    base_sha: plan.base_sha, prior_sha: mutant.prior_sha, prior_outcome: mutant.prior_outcome, applied: false,
    outcome: 'invalid', reason: '', oracle_kind: null,
    oracle_cmds: mutant.oracles.map(name => ({ name, kind: plan.oracles[name].kind, command: plan.oracles[name].command })),
    baseline_exit: mutant.oracles.map(name => baseline[name].exit), mutant_exit: [], seconds: 0, log: [], restore_sha256: null,
  }
  const notes = []
  if (mutant.retarget_reason) notes.push(mutant.retarget_reason)
  if (mutant.note) notes.push(mutant.note)
  const before = readDefinition()
  const beforeHash = hash(before)
  try {
    const count = before.split(mutant.original).length - 1
    if (count === 0) throw new Error('target-removed: the original text is absent from the current definition')
    if (count !== 1) throw new Error(`target-ambiguous: the original text occurs ${count} times`)
    applyDefinition(before.replace(mutant.original, () => mutant.mutated))
    row.applied = true
    const mutatedHash = hash(readDefinition())
    assert.notEqual(mutatedHash, beforeHash)
    if (http) {
      await restartEdge()
      assert.equal(servedFileSha(mutant.file), mutatedHash, 'The served Edge runtime must load the mutated source')
      notes.push(`served mutant sha256 ${mutatedHash}`)
    }
    const results = mutant.oracles.map(name => runOracle(name, mutant.id))
    row.mutant_exit = results.map(result => result.exit)
    row.seconds = Math.round(results.reduce((sum, result) => sum + result.seconds, 0) * 100) / 100
    row.log = results.map(result => result.log)
    const killers = results.filter(result => result.exit !== 0 && result.exit !== 124 && !result.compile && !result.crash)
    const used = killers.length ? killers : results
    row.oracle_kind = used.map(result => plan.oracles[result.name].kind).sort((a, b) => kindRank.indexOf(b) - kindRank.indexOf(a))[0]
    const compiled = results.filter(result => result.compile)
    if (compiled.length) notes.push(`compile failure only, not counted: ${compiled.map(result => `${result.name} (exit ${result.exit})`).join(', ')}`)
    const crashes = results.filter(result => result.crash)
    if (crashes.length) notes.push(`oracle process crashed, not counted: ${crashes.map(result => `${result.name} (exit ${result.exit})`).join(', ')}`)
    if (killers.length) {
      row.outcome = 'killed'
      notes.push(`killed by ${killers.map(result => `${result.name} (${plan.oracles[result.name].kind}, exit ${result.exit}): ${result.evidenceLine}`).join('; ')}`)
      const missed = results.filter(result => result.exit === 0)
      if (missed.length) notes.push(`passed under the mutant: ${missed.map(result => result.name).join(', ')}`)
    } else if (results.some(result => result.exit === 124)) {
      row.outcome = 'timeout'
    } else if (compiled.length || crashes.length) {
      row.outcome = 'invalid'
    } else {
      row.outcome = 'survived'
    }
  } catch (error) {
    notes.push(error.message)
  } finally {
    applyDefinition(before)
    const restored = hash(readDefinition())
    assert.equal(restored, beforeHash, 'Definition restore hash mismatch; stop batch')
    row.restore_sha256 = restored
    if (http && row.applied) {
      await restartEdge()
      assert.equal(servedFileSha(mutant.file), beforeHash, 'The served Edge runtime must reload the restored source')
      notes.push('served restore verified')
    }
    row.reason = notes.join(' | ')
    appendFileSync(`${evidence}/results.jsonl`, JSON.stringify(row) + '\n')
  }
  console.log(`${row.id} ${row.outcome} ${row.mutant_exit.join(',')} ${row.oracle_kind ?? ''}`)
}
