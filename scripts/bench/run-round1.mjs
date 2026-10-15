import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'

const [base, evidence, mode] = process.argv.slice(2)
const root = process.cwd()
const db = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:56322/postgres'
const address = new URL(db)
if (!base || !evidence || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.port !== '56322') {
  throw new Error('Pass the archived base source and evidence directory for the isolated local database.')
}
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, SUPABASE_DB_URL: db } })
const database = (file) => run('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-f', file])
const benchmark = (side, source, label) => run('deno', ['run', '--no-lock', '--node-modules-dir=none', '-A', 'scripts/bench/pre-tipoff.ts', side, source, evidence, label])
const snapshot = (label) => {
  const destination = path.join(evidence, `${label}-src`)
  mkdirSync(destination, { recursive: true })
  const archive = execFileSync('git', ['archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', destination], { input: archive })
  const changed = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split('\n')
  const added = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')
  for (const relative of [...changed, ...added].filter(Boolean)) {
    if (existsSync(path.join(root, relative))) {
      mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true })
      cpSync(path.join(root, relative), path.join(destination, relative), { recursive: true })
    }
  }
  return destination
}
const files = ['supabase/sql/functions/by-name/public/apply_pre_tipoff_lineup.sql', 'supabase/migrations/20261014000001_pre_tipoff_lineups.sql']
const before = `  UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
   WHERE tipoff_at = p_tipoff_at;`
const after = `  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at;
  END IF;`
if (mode && mode !== '--resume-old') throw new Error('Only --resume-old is supported.')
if (['new-initial', 'new-improved'].some((label) => existsSync(path.join(evidence, `${label}-statistics-info.json`)))
  || (mode !== '--resume-old' && existsSync(path.join(evidence, 'old-statistics-info.json')))) {
  throw new Error('Existing measurements are immutable. Use a fresh evidence directory and copy pinned inputs and OLD outputs when resuming.')
}
const originals = files.map((file) => readFileSync(file, 'utf8'))
const baseline = originals.map((source, index) => {
  const normalized = source.includes(after) ? source.replace(after, before) : source
  if (normalized.split(before).length !== 2) throw new Error(`Cannot locate the single lease update in ${files[index]}`)
  return normalized
})
if (mode === '--resume-old') {
  console.log('Waiting for the running base season to finish.')
  while (!existsSync(path.join(evidence, 'old-statistics-info.json'))) await setTimeout(30000)
} else {
  database('scripts/bench/restore-clock.sql')
  database('scripts/bench/base-schema.sql')
  benchmark('old', base, 'old')
}
console.log('The base season is complete.')
database('scripts/bench/restore-clock.sql')
database('scripts/bench/base-schema.sql')
for (let i = 0; i < files.length; i++) writeFileSync(files[i], baseline[i])
let schemaReady = false
let completed = false
try {
  database('supabase/migrations/20261014000001_pre_tipoff_lineups.sql')
  schemaReady = true
  const initialSource = snapshot('new-initial')
  benchmark('new', initialSource, 'new-initial')
  const initial = JSON.parse(readFileSync(path.join(evidence, 'new-initial-result.json'), 'utf8'))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (source.split(before).length !== 2) throw new Error(`Cannot locate the single lease update in ${file}`)
    writeFileSync(file, source.replace(before, after))
  }
  const metrics = ['statements', 'topLevelStatements', 'statementRows', 'tableRowsRead', 'tableRowsWritten', 'productionTableRowsWritten', 'invocations', 'wallSeconds']
  let candidate = null
  let failure = null
  let kept = false
  try {
    database(files[0])
    const candidateSource = snapshot('new-improved')
    benchmark('new', candidateSource, 'new-improved')
    candidate = JSON.parse(readFileSync(path.join(evidence, 'new-improved-result.json'), 'utf8'))
    const initialLineups = JSON.parse(readFileSync(path.join(evidence, 'new-initial-lineups.json'), 'utf8'))
    const candidateLineups = JSON.parse(readFileSync(path.join(evidence, 'new-improved-lineups.json'), 'utf8'))
    kept = candidate.statements < initial.statements && candidate.tableRowsWritten < initial.tableRowsWritten
      && metrics.every((metric) => candidate[metric] <= initial[metric])
      && candidate.checkedTipoffs === initial.checkedTipoffs && candidate.exactTipoffs === initial.exactTipoffs && JSON.stringify(initialLineups) === JSON.stringify(candidateLineups)
  } catch (error) {
    failure = String(error)
  }
  if (!kept) {
    for (const file of files) cpSync(path.join(initialSource, file), file)
    database(files[0])
  }
  const regressions = candidate ? metrics.filter((metric) => candidate[metric] > initial[metric]).map((metric) => ({ metric, before: initial[metric], after: candidate[metric] })) : []
  writeFileSync(path.join(evidence, 'round1-decision.json'), JSON.stringify({ kept, failure, initial, candidate, regressions }, null, 2))
  run('deno', ['run', '--no-lock', '--node-modules-dir=none', '-A', 'scripts/bench/compare.ts', evidence, 'old', 'new-initial', ...(candidate ? ['new-improved'] : [])])
  console.log(JSON.stringify({ kept, failure, regressions }, null, 2))
  if (failure) throw new Error(failure)
  completed = true
} finally {
  if (!completed) {
    for (let i = 0; i < files.length; i++) writeFileSync(files[i], originals[i])
    if (schemaReady) database(files[0])
  }
  database('scripts/bench/restore-clock.sql')
}
