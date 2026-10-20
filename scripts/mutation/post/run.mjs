import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const lane = resolve(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), resolve(lane, 'repo'))
const evidence = process.env.POST_EVIDENCE ?? resolve(lane, 'evidence')
assert.ok(evidence.startsWith(`${lane}/`))
mkdirSync(evidence, { recursive: true })
const db = 'postgresql://postgres:postgres@127.0.0.1:57422/postgres'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, '57422')
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')] }))
assert.equal(new URL(keys.API_URL).port, '57421')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(keys.API_URL).hostname))
const env = { ...process.env, SUPABASE_DB_URL: db, SUPABASE_URL: keys.API_URL, SUPABASE_ANON_KEY: keys.ANON_KEY, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token' }
const sql = statement => {
  const result = spawnSync('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  return result.stdout.trim()
}
const hash = value => createHash('sha256').update(value).digest('hex')
const definition = symbol => sql(`SELECT pg_get_functiondef('${symbol}'::regprocedure);`)
const catalog = JSON.parse(readFileSync('scripts/mutation/post/catalog.json', 'utf8'))
const selection = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const selected = catalog.filter(item => selection.length === 0 || selection.includes(item.id) || selection.includes(item.area))
assert.ok(selected.length)
const runOracle = (oracle, prefix) => {
  assert.match(oracle.name, /^[\w.-]+$/)
  const log = `${evidence}/${prefix}-${oracle.name}.log`
  const started = performance.now()
  const result = spawnSync('/bin/sh', ['-c', oracle.command], { env, encoding: 'utf8', timeout: oracle.timeout ?? 120_000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(log, `${oracle.command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status} signal=${result.signal} error=${result.error?.code ?? ''}\n`)
  return { name: oracle.name, command: oracle.command, exit: result.error?.code === 'ETIMEDOUT' ? 124 : result.status ?? 125, seconds: Math.round((performance.now() - started) / 10) / 100, log }
}
const unique = [...new Map(selected.flatMap(item => item.oracles).map(oracle => [oracle.command, oracle])).values()]
const baseline = unique.map(oracle => runOracle(oracle, 'baseline'))
writeFileSync(`${evidence}/baseline-green.log`, baseline.map(result => JSON.stringify(result)).join('\n') + '\n')
assert.ok(baseline.every(result => result.exit === 0), `Baseline fails: ${baseline.filter(result => result.exit !== 0).map(result => result.log).join(', ')}`)
if (process.argv.includes('--baseline')) process.exit(0)
for (const mutant of selected) {
  const { oracles: commands, ...metadata } = mutant
  const row = { ...metadata, applied: false, outcome: 'invalid', oracles: [], killed_by: [], notes: 'SYNTHETIC fixtures; application mutation; baseline green.' }
  const isTypeScript = mutant.file.endsWith('.ts')
  if (isTypeScript) assert.equal(mutant.file, 'supabase/functions/_shared/seasonBoundary.ts')
  const readDefinition = () => isTypeScript ? readFileSync(mutant.file, 'utf8') : definition(mutant.symbol)
  const applyDefinition = value => isTypeScript ? writeFileSync(mutant.file, value) : sql(value)
  const before = readDefinition()
  const beforeHash = hash(before)
  try {
    assert.equal(before.split(mutant.original).length - 1, 1, 'Mutation must match exactly one application expression')
    applyDefinition(before.replace(mutant.original, mutant.mutated))
    row.applied = true
    assert.notEqual(hash(readDefinition()), beforeHash)
    for (const oracle of commands) row.oracles.push(runOracle(oracle, mutant.id))
    row.killed_by = row.oracles.filter(result => result.exit !== 0 && result.exit !== 124).map(result => result.name)
    row.outcome = row.oracles.some(result => result.exit === 124) ? 'timeout' : row.killed_by.length ? 'killed' : 'survived'
  } catch (error) {
    row.notes += ` ${error.message}`
  } finally {
    applyDefinition(before)
    assert.equal(hash(readDefinition()), beforeHash, 'Definition restore hash mismatch; stop batch')
    row.notes += ` Restore SHA-256 verified: ${beforeHash}.`
    appendFileSync(`${evidence}/results.jsonl`, JSON.stringify(row) + '\n')
  }
  console.log(`${row.id} ${row.outcome} ${row.killed_by.join(',')}`)
}
