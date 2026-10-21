import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function runCutoffReview() {
  const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
  assert.equal(process.cwd(), path.join(lane, 'repo'))
  const evidence = path.join(lane, 'evidence/review9')
  mkdirSync(path.join(evidence, 'green'), { recursive: true })
  const keys = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').map(line => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]
  }))
  for (const [url, port] of [[keys.API_URL, '57421'], [keys.DB_URL, '57422']]) {
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    assert.equal(new URL(url).port, port)
  }
  const env = { ...process.env, SUPABASE_URL: keys.API_URL, SUPABASE_DB_URL: keys.DB_URL,
    PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'local-database-ci-token',
    PANCAKE_TEST_API_PORT: '57421', PANCAKE_TEST_DB_PORT: '57422' }
  const rows = []
  const mode = process.argv.includes('--cutoff-red') ? 'red' : process.argv.includes('--cutoff-static') ? 'static' : process.argv.includes('--cutoff-tooling') ? 'tooling' : 'green'
  const run = (name, binary, args, expected = 0) => {
    const start = performance.now()
    const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 })
    const log = path.join(evidence, `${mode}/${name}.log`)
    mkdirSync(path.dirname(log), { recursive: true })
    const command = `${binary} ${args.join(' ')}`
    writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status} signal=${result.signal}\n`)
    const row = { name, command, exit: result.status, seconds: Math.round((performance.now() - start) / 10) / 100, log }
    rows.push(row)
    writeFileSync(path.join(evidence, `commands-${mode}.json`), JSON.stringify(rows, null, 2) + '\n')
    console.log(JSON.stringify(row))
    assert.equal(result.status, expected, log)
  }
  if (mode === 'red') {
    const file = 'supabase/functions/_shared/seasonBoundary.ts'
    const before = readFileSync(file, 'utf8')
    const hash = value => createHash('sha256').update(value).digest('hex')
    try {
      writeFileSync(file, readFileSync(path.join(evidence, 'base-seasonBoundary.ts'), 'utf8'))
      for (const state of ['cutoff_race', 'cutoff_error', 'cutoff_publish']) run(state, 'env', [`POST_ROOKIE_CASE=${state}`, 'node', 'scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-backstop.ts'], 1)
      run('skipped-cutoff', 'env', ['POST_SKIP_PHASE=timing', 'node', 'scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-skipped-week.ts'], 1)
    } finally {
      writeFileSync(file, before)
      assert.equal(hash(readFileSync(file, 'utf8')), hash(before))
      writeFileSync(path.join(evidence, 'red/restore-hash.txt'), `Base application: 29b11f67
Restored SHA-256: ${hash(before)}\n`)
    }
    return
  }
  if (mode === 'tooling') {
    run('eslint', 'npx', ['eslint', 'scripts/mutation/post/cutoff-review.mjs', 'scripts/mutation/post/report.mjs', '--max-warnings=0'])
    run('typecheck-e2e', 'npm', ['run', 'typecheck:e2e'])
    run('knip', 'npm', ['run', 'check:dead-code'])
    const files = ['scripts/mutation/post/catalog.json', 'scripts/mutation/post/cutoff-review.mjs', 'scripts/mutation/post/integration.mjs', 'scripts/mutation/post/report.mjs',
      'supabase/functions/_shared/seasonBoundary.ts', 'supabase/functions/_shared/seasonBoundaryCalendar.test.ts', 'supabase/tests/db/rookie-backstop.ts', 'supabase/tests/db/rookie-skipped-week.ts']
    writeFileSync(path.join(evidence, 'source-manifest.json'), JSON.stringify(Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])), null, 2) + '\n')
    return
  }
  if (mode === 'static') {
    const changed = ['supabase/functions/_shared/seasonBoundary.ts', 'supabase/functions/_shared/seasonBoundaryCalendar.test.ts', 'supabase/tests/db/rookie-backstop.ts', 'supabase/tests/db/rookie-skipped-week.ts', 'scripts/mutation/post/cutoff-review.mjs', 'scripts/mutation/post/integration.mjs', 'scripts/mutation/post/report.mjs']
    run('eslint', 'npx', ['eslint', ...changed, '--max-warnings=0'])
    run('deno-check', 'deno', ['check', '--no-lock', ...changed.filter(file => file.endsWith('.ts'))])
    run('db-sources', 'node', ['scripts/check-db-function-sources.mjs', '--check'])
    run('edge-shared', 'node', ['scripts/generate-edge-shared.mjs', '--check'])
    run('boundary-unit', 'deno', ['test', '--no-lock', '--allow-env', '--allow-read', '--allow-net=127.0.0.1,localhost', 'supabase/functions/_shared/seasonBoundaryCalendar.test.ts', 'supabase/functions/_shared/seasonBoundaryFailures.test.ts', 'supabase/functions/_shared/octoberGap.test.ts'])
    run('edge-functions', 'npm', ['run', 'check:edge-functions'])
    run('typecheck-e2e', 'npm', ['run', 'typecheck:e2e'])
    run('knip', 'npm', ['run', 'check:dead-code'])
    return
  }
  for (let pass = 1; pass <= 2; pass++) {
    for (const state of ['cutoff_race', 'cutoff_error', 'cutoff_publish']) run(`pass${pass}-${state}`, 'env', [`POST_ROOKIE_CASE=${state}`, 'node', 'scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-backstop.ts'])
    run(`pass${pass}-rookie-backstop`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-backstop.ts'])
    run(`pass${pass}-rookie-skipped-week`, 'node', ['scripts/mutation/post/check.mjs', 'supabase/tests/db/rookie-skipped-week.ts'])
    run(`pass${pass}-season-boundary-et`, 'npm', ['run', 'test:db:season-boundary-et'])
  }
}
