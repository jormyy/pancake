// Current-head SQL mutant reruns (card t_4ba51e0d common-t10 protocol) on the local stack this checkout owns.
// Each mutant edits the deployed definition (pg_get_functiondef), runs its killing oracle, then restores and
// hash-verifies the definition. Rows use the turn-10 results.jsonl schema.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const sha256 = value => createHash('sha256').update(value).digest('hex')

export function ownedStack() {
  const config = readFileSync('supabase/config.toml', 'utf8')
  const project = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1]
  assert(project && (process.env.PANCAKE_TEST_PROJECT_ID ?? project) === project, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
  const configPort = section => new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm').exec(config)?.[1]
  const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const keys = Object.fromEntries(status.split('\n').flatMap(line => {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line)
    return match ? [[match[1], match[2]]] : []
  }))
  const ports = {}
  for (const [key, section, override] of [['API_URL', 'api', 'PANCAKE_TEST_API_PORT'], ['DB_URL', 'db', 'PANCAKE_TEST_DB_PORT']]) {
    const url = new URL(keys[key])
    const expected = process.env[override] ?? configPort(section)
    assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === expected, `Only the owned loopback port ${expected} is allowed`)
    assert(!url.port.startsWith('582'), 'Refuse the protected replay block 582xx')
    assert(!url.port.startsWith('543') || configPort('api').startsWith('543'), 'Refuse the orchestrator block 543xx from another checkout')
    ports[section] = url.port
  }
  const env = {
    ...process.env, SUPABASE_URL: keys.API_URL, SUPABASE_DB_URL: keys.DB_URL,
    PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
    PANCAKE_TEST_PROJECT_ID: project, PANCAKE_TEST_API_PORT: ports.api, PANCAKE_TEST_DB_PORT: ports.db,
  }
  const sql = statement => execFileSync('psql', [keys.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { project, keys, ports, env, sql }
}

export function latestDefinition(symbol, original) {
  const [schema, name] = symbol.split('(')[0].split('.')
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:${schema}\\.)?${name}\\s*\\(`, 'gi')
  let latest
  for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
    const source = readFileSync(join('supabase/migrations', file), 'utf8')
    for (const match of source.matchAll(pattern)) latest = { file: `supabase/migrations/${file}`, source, start: match.index }
  }
  assert(latest, `No migration defines ${symbol}`)
  const end = latest.source.indexOf('$$;', latest.source.indexOf('$$', latest.start) + 2)
  const at = latest.source.slice(latest.start, end).indexOf(original)
  const line = latest.source.slice(0, at >= 0 ? latest.start + at : latest.start).split('\n').length
  return { file: latest.file, line, present: at >= 0 }
}

const display = (command, stack) => command.map(part => part === stack.keys.DB_URL ? '"$SUPABASE_DB_URL"' : part).join(' ')

export function oracleRunner(stack, evidence, baseSha) {
  mkdirSync(join(evidence, 'logs'), { recursive: true })
  return (label, oracle) => {
    const started = performance.now()
    const result = spawnSync(oracle.command[0], oracle.command.slice(1), { encoding: 'utf8', env: stack.env, timeout: oracle.timeout ?? 300_000, maxBuffer: 64 * 1024 * 1024 })
    const log = join(evidence, 'logs', `${label}.log`)
    writeFileSync(log, `$ ${display(oracle.command, stack)}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    const record = { label, oracle: oracle.name, command: display(oracle.command, stack), exit: result.status ?? 124,
      timedOut: result.error?.code === 'ETIMEDOUT', seconds: Number(((performance.now() - started) / 1000).toFixed(3)), log: relative(evidence, log), baseSha }
    appendFileSync(join(evidence, 'commands.jsonl'), JSON.stringify(record) + '\n')
    console.log(JSON.stringify(record))
    return { ...record, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
}

// A failure only kills when the oracle reached a behavioral check, never on a harness guard or setup error.
const harnessFailure = output => /Only the (?:expected|owned)|Refuse the |PANCAKE_TEST_PROJECT_ID must|Type checking failed|error: (?:Module not found|Uncaught \(in promise\) TypeError: error sending request)|could not connect to server|Connection refused/.test(output)

export function rerunMutants({ lane, mutants, oracles, evidence = resolve(process.env.T10_EVIDENCE ?? `evidence/t10/${lane}`), baseSha, stack = ownedStack() }) {
  assert.match(baseSha ?? '', /^[0-9a-f]{40}$/, 'Pass the measured checkout SHA')
  const run = oracleRunner(stack, evidence, baseSha)
  const baselines = {}
  for (const key of new Set(mutants.map(mutant => mutant.oracle))) {
    baselines[key] = run(`baseline-${key}`, oracles[key])
    assert.equal(baselines[key].exit, 0, `Baseline ${key} must pass before any mutant`)
  }
  const rows = []
  for (const mutant of mutants) {
    // SQL mutants overlay the deployed function; TS mutants edit the runtime source file in this checkout.
    const read = () => mutant.symbol ? stack.sql(`SELECT pg_get_functiondef('${mutant.symbol}'::regprocedure)`) : readFileSync(mutant.file, 'utf8')
    const write = source => mutant.symbol ? stack.sql(source) : writeFileSync(mutant.file, source)
    const definition = read()
    const digest = sha256(definition)
    const occurrences = definition.split(mutant.original).length - 1
    const latest = mutant.symbol ? latestDefinition(mutant.symbol, mutant.original)
      : { file: mutant.file, line: definition.slice(0, Math.max(definition.indexOf(mutant.original), 0)).split('\n').length }
    let applied = false, outcome = 'invalid', reason = '', check
    try {
      if (occurrences === 0) reason = `target-removed: original text is absent from the deployed definition. Nearest current equivalent: ${mutant.nearest ?? 'none'}`
      else if (occurrences > 1) reason = `ambiguous: original text occurs ${occurrences} times in the deployed definition`
      else {
        try { write(definition.replace(mutant.original, mutant.mutated)); applied = true }
        catch (error) { reason = `overlay does not apply: ${String(error.stderr ?? error).trim().split('\n').at(-1)}` }
      }
      if (applied) {
        check = run(mutant.id, oracles[mutant.oracle])
        if (check.timedOut) { outcome = 'timeout'; reason = 'oracle exceeded its limit' }
        else if (check.exit === 0) { outcome = 'survived'; reason = mutant.survivorNote ?? 'all oracles pass; needs classification' }
        else if (harnessFailure(check.output)) { outcome = 'invalid'; reason = 'oracle stopped at a harness guard or setup error, not a behavioral check' }
        else {
          outcome = 'killed'
          const output = check.output.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
          const errors = output.filter(line => /AssertionError|ERROR:/.test(line))
          const lines = errors.length ? errors : output.filter(line => /Error:|expected|actual|RAISE|EXCEPTION|!==/i.test(line))
          reason = `behavioral failure: ${lines.slice(0, 3).join(' | ').replace(/\s+/g, ' ').slice(0, 400)}`
        }
      }
    } finally {
      if (applied) write(definition)
      assert.equal(sha256(read()), digest, `Restore of ${mutant.id} must match`)
    }
    const row = {
      id: mutant.id, lane, area: mutant.area, file: latest.file, line: latest.line, symbol: mutant.symbol ?? mutant.function,
      operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, base_sha: baseSha,
      prior_sha: mutant.priorSha ?? null, prior_outcome: mutant.priorOutcome ?? null, applied, outcome, reason,
      oracle_kind: oracles[mutant.oracle].kind, oracle_cmds: [oracles[mutant.oracle].display ?? display(oracles[mutant.oracle].command, stack)],
      baseline_exit: baselines[mutant.oracle].exit, mutant_exit: check?.exit ?? null, seconds: check?.seconds ?? 0,
      log: check?.log ?? null, restore_sha256: digest,
    }
    if (mutant.notes) row.notes = mutant.notes
    rows.push(row)
    appendFileSync(join(evidence, 'results.jsonl'), JSON.stringify(row) + '\n')
    console.log(JSON.stringify({ id: row.id, outcome, reason }))
  }
  for (const key of Object.keys(baselines)) assert.equal(run(`restored-${key}`, oracles[key]).exit, 0, `Restored ${key} must pass`)
  return rows
}

export function scanTargets(stack, targets) {
  return targets.map(target => {
    if (target.symbol) {
      const definition = stack.sql(`SELECT pg_get_functiondef('${target.symbol}'::regprocedure)`)
      const latest = latestDefinition(target.symbol, target.original)
      return { id: target.id, symbol: target.symbol, measuredFile: target.file, latestFile: latest.file, line: latest.line,
        superseded: latest.file !== target.file, deployedOccurrences: definition.split(target.original).length - 1, definitionSha256: sha256(definition) }
    }
    const source = readFileSync(target.file, 'utf8')
    return { id: target.id, file: target.file, occurrences: source.split(target.original).length - 1, fileSha256: sha256(source) }
  })
}
