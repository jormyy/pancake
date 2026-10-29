import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const options = new Set(process.argv.slice(2))
const registered = new Set([
  'pick-window.sql', 'pick-window-cleanup.sql', 'pick-draft-year.sql',
  'player-data-identity.sql', 'player-data-merges.sql', 'player-data-career.sql',
  'player-data-base.sql', 'player-data-base-regressions.sql',
  'player-data-appearances.sql', 'player-data-regular-season.sql',
])
const sqlFiles = readdirSync('tests/db').filter(file => file.endsWith('.sql')).sort()
const included = new Set(sqlFiles.flatMap(file => [...readFileSync(`tests/db/${file}`, 'utf8')
  .matchAll(/^\s*\\ir\s+([^\s]+)/gm)].map(match => basename(match[1]))))
const roots = sqlFiles.filter(file => !included.has(file))
const recipes = roots.filter(file => !options.has('--omit-registered') || !registered.has(file))
  .sort((a, b) => Number(a === 'league-version-writes.sql') - Number(b === 'league-version-writes.sql') || a.localeCompare(b))
const bugs = JSON.parse(readFileSync('tests/db/known-bugs.json', 'utf8'))
const regressions = readdirSync('tests/db/regressions').filter(file => file.endsWith('.sql')).sort()
  .map(file => `regressions/${file}`)
assert.equal(new Set(bugs.map(bug => bug.file)).size, bugs.length, 'Known bugs must be unique')
assert.ok(bugs.every(bug => regressions.includes(bug.file)), 'Every known bug must have a regression')
const fixedRegressions = regressions.filter(file => !bugs.some(bug => bug.file === file))
const cases = options.has('--bugs') ? bugs.map(bug => ({ file: bug.file, expectedError: bug.error }))
  : [...recipes, ...fixedRegressions].flatMap(file => file === 'calendar-ingestion.sql'
    ? ['durable', 'outside', 'cross-week'].map(mode => ({ file, mode }))
    : file === 'notif-producers.sql' ? ['false', 'true'].map(mode => ({ file, mode })) : [{ file }])
if (options.has('--list')) {
  console.log(JSON.stringify({ cases, included: [...included].filter(file => sqlFiles.includes(file)).sort() }, null, 2))
  process.exit(0)
}

const target = new URL(process.env.SUPABASE_DB_URL)
const config = readFileSync('supabase/config.toml', 'utf8')
const configValue = section => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
assert.ok(!target.search && !target.hash, 'Database target overrides are not allowed')
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Use a private loopback database')
assert.equal(target.port, process.env.PANCAKE_TEST_DB_PORT, 'Set the private database port')
assert.equal(target.port, configValue('db'), 'The database must belong to this checkout')
assert.equal(process.env.PANCAKE_TEST_API_PORT, configValue('api'), 'Set the private API port')
assert.equal(process.env.PANCAKE_TEST_PROJECT_ID, config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1], 'Set the private project ID')
const api = new URL(process.env.SUPABASE_URL)
assert.ok(api.protocol === 'http:' && !api.search && !api.hash)
assert.ok(['127.0.0.1', 'localhost'].includes(api.hostname))
assert.equal(api.port, configValue('api'))
const started = performance.now()
const results = []
const logDirectory = process.env.PANCAKE_DB_TEST_LOG_DIR
if (logDirectory) mkdirSync(logDirectory, { recursive: true })
for (const recipe of cases) {
  const env = { ...process.env }
  const args = [target.href, '-X', '-v', 'ON_ERROR_STOP=1']
  if (recipe.file === 'calendar-ingestion.sql') env.PGOPTIONS = `${env.PGOPTIONS ?? ''} -c post.calendar_case=${recipe.mode}`.trim()
  if (recipe.file === 'notif-producers.sql') args.push('-v', `notif_disabled=${recipe.mode}`)
  args.push('-f', `tests/db/${recipe.file}`)
  const begin = performance.now()
  const result = recipe.file === 'waiver-backlog-behavior.sql'
    ? spawnSync(process.execPath, ['tests/e2e/waiver-backlog-db.mjs'], { env, encoding: 'utf8', timeout: 90_000 })
    : spawnSync('psql', args, { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const errors = output.split('\n').filter(line => line.includes('ERROR:'))
  const passed = !result.error && (recipe.expectedError
    ? result.status === 3 && errors.length === 1 && errors[0].endsWith(recipe.expectedError)
    : result.status === 0)
  const seconds = Number(((performance.now() - begin) / 1000).toFixed(2))
  const entry = { recipe: recipe.file, mode: recipe.mode, passed, seconds }
  results.push(entry)
  console.log(`${passed ? recipe.expectedError ? 'REPRODUCED BUG' : 'PASS' : 'FAIL'} ${recipe.file}${recipe.mode ? ` (${recipe.mode})` : ''} ${seconds}s`)
  if (!passed) console.error(result.error?.message ?? output)
  if (logDirectory) writeFileSync(join(logDirectory, `${basename(recipe.file)}${recipe.mode ?? ''}.log`), output)
  if (result.error || performance.now() - started >= 600_000) {
    console.error('The sweep stops after a process error or its ten minute budget')
    process.exitCode = 1
    break
  }
}
const seconds = Number(((performance.now() - started) / 1000).toFixed(2))
console.log(JSON.stringify({ passed: results.filter(result => result.passed).length,
  failed: results.filter(result => !result.passed).length, total: cases.length, seconds }))
if (logDirectory) writeFileSync(join(logDirectory, options.has('--bugs') ? 'results-bugs.json' : 'results.json'), JSON.stringify(results, null, 2))
if (results.length !== cases.length || results.some(result => !result.passed)) process.exitCode = 1
