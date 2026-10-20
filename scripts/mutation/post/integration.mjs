import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const evidence = path.join(lane, 'evidence/review5')
mkdirSync(evidence, { recursive: true })
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.trim().split('\n').map(line => {
  const at = line.indexOf('=')
  return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]
}))
for (const [target, port] of [[keys.API_URL, '57421'], [keys.DB_URL, '57422']]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
  assert.equal(new URL(target).port, port)
}
const env = {
  ...process.env,
  SUPABASE_URL: keys.API_URL,
  E2E_SUPABASE_URL: keys.API_URL,
  SUPABASE_DB_URL: keys.DB_URL,
  E2E_PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
  PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY,
  E2E_SUPABASE_PUBLISHABLE_KEY: keys.PUBLISHABLE_KEY ?? keys.ANON_KEY,
  PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
  PANCAKE_TEST_API_PORT: '57421',
  PANCAKE_TEST_DB_PORT: '57422',
}
for (const key of ['POST_ROOKIE_CASE', 'POST_SKIP_PHASE', 'POST_STALE_CASE']) delete env[key]
const rows = []
const run = (name, binary, args, options = {}) => {
  const started = performance.now()
  const result = spawnSync(binary, args, { env: options.env ?? env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  const log = path.join(evidence, `${name}.log`)
  const command = `${binary} ${args.join(' ')}`
  writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status} signal=${result.signal}\n`)
  const row = { name, command, exit: result.status, seconds: Math.round((performance.now() - started) / 10) / 100, log, expected: options.expected ?? 0 }
  rows.push(row)
  writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(rows, null, 2)+'\n')
  console.log(JSON.stringify(row))
  assert.equal(result.status, row.expected, log)
}
const fixtureCounts = () => execFileSync('psql', [keys.DB_URL, '-XqAtv', 'ON_ERROR_STOP=1', '-c', "SELECT jsonb_build_object('users',(SELECT count(*) FROM auth.users),'leagues',(SELECT count(*) FROM leagues),'claims',(SELECT count(*) FROM waiver_claims))"], { encoding: 'utf8' }).trim()
const registrations = JSON.parse(readFileSync('scripts/mutation/post/registrations.json', 'utf8'))
const skipped = []
for (const name of Object.keys(registrations['test:db chain'])) {
  if (name === 'test:db:live-score-overlap') { skipped.push({ name, reason: 'Concurrent live-owned TypeScript port-default change; user requested this skip.' }); continue }
  run(name.replaceAll(':', '-'), 'npm', ['run', name])
}
for (const name of ['evidence:db:rookie-skipped-week', 'evidence:db:playoff-stale-boundary']) {
  run(name.replaceAll(':', '-'), 'npm', ['run', name])
}
writeFileSync(path.join(evidence, 'skipped.json'), JSON.stringify(skipped, null, 2)+'\n')
const before = fixtureCounts()
const defaultEnv = { ...env }
delete defaultEnv.PANCAKE_TEST_API_PORT
delete defaultEnv.PANCAKE_TEST_DB_PORT
run('ci-default-refusal', 'npm', ['run', 'test:db:rookie-backstop'], { env: defaultEnv, expected: 1 })
assert.equal(fixtureCounts(), before, 'A refused target must not change fixtures')
assert.match(readFileSync(path.join(evidence, 'ci-default-refusal.log'), 'utf8'), /54321/)
writeFileSync(path.join(evidence, 'refusal-counts.json'), JSON.stringify({ before: JSON.parse(before), after: JSON.parse(fixtureCounts()) }, null, 2)+'\n')
run('registrations', 'node', ['scripts/mutation/post/check-registrations.mjs'])
const original = JSON.parse(readFileSync('package.json', 'utf8'))
for (const control of ['missing', 'duplicate', 'evidence-in-chain']) {
  const changed = structuredClone(original)
  const name = Object.keys(registrations['test:db chain'])[0]
  if (control === 'missing') changed.scripts['test:db'] = changed.scripts['test:db'].replace(` && npm run ${name}`, '')
  if (control === 'duplicate') changed.scripts['test:db'] += ` && npm run ${name}`
  if (control === 'evidence-in-chain') changed.scripts['test:db'] += ' && npm run evidence:db:rookie-skipped-week'
  const file = path.join(evidence, `${control}-package.json`)
  writeFileSync(file, JSON.stringify(changed))
  run(`registrations-${control}`, 'node', ['scripts/mutation/post/check-registrations.mjs', file], { expected: 1 })
}
run('mutation-overrides', 'node', ['scripts/mutation/post/run.mjs', '--baseline', 'rookie-draft-13', 'rookie-draft-17'], { env: { ...env, POST_EVIDENCE: path.join(evidence, 'mutation-baseline') } })
run('checker-overrides', 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-backstop.ts'])
run('typecheck', 'deno', ['check', '--no-lock', 'supabase/tests/db/rookie-backstop.ts', 'supabase/tests/db/rookie-skipped-week.ts', 'supabase/tests/db/playoff-stale-boundary.ts'])
run('eslint', 'npx', ['eslint', 'scripts/mutation/post/check.mjs', 'scripts/mutation/post/run.mjs', 'scripts/mutation/post/setup.mjs', 'scripts/mutation/post/check-registrations.mjs', 'scripts/mutation/post/integration.mjs', 'supabase/tests/db/rookie-backstop.ts', 'supabase/tests/db/rookie-skipped-week.ts', 'supabase/tests/db/playoff-stale-boundary.ts', '--max-warnings=0', '--no-warn-ignored'])
run('function-sources', 'node', ['scripts/check-db-function-sources.mjs', '--check'])
console.log('New registrations pass on the reset local stack; expected default-port and structural refusals pass.')
