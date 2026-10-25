import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const evidence = path.join(lane, 'evidence')
const source = 'supabase/functions/_shared/seasonBoundary.ts'
const fixture = 'supabase/tests/db/playoff-stale-boundary.ts'
const rookieFixture = 'supabase/tests/db/rookie-skipped-week.ts'
const before = readFileSync(path.join(evidence, 'review4/seasonBoundary-before.ts'), 'utf8')
assert.ok(!before.includes('applyBoundaryWithScoreRefresh'))
const fixed = readFileSync(source, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const fixtureHash = hash(readFileSync(fixture))
const rookieFixtureHash = hash(readFileSync(rookieFixture))
const results = []
const run = (phase, state, expected, file = fixture) => {
  const command = `${state ? `POST_STALE_CASE=${state} ` : ''}node scripts/mutation/post/check.mjs ${file}`
  const env = { ...process.env }
  delete env.POST_STALE_CASE
  if (state) env.POST_STALE_CASE = state
  const result = spawnSync('node', ['scripts/mutation/post/check.mjs', file], { env, encoding: 'utf8', timeout: 120_000 })
  const label = file === fixture ? `${state || 'all'}-stale-boundary-final` : 'rookie-skipped-week-without-replay'
  const log = path.join(evidence, `${phase}/${label}.log`)
  mkdirSync(path.dirname(log), { recursive: true })
  writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`)
  results.push({ command, exit: result.status, log })
  assert.equal(result.status, expected, log)
  assert.equal(hash(readFileSync(fixture)), fixtureHash)
  assert.equal(hash(readFileSync(rookieFixture)), rookieFixtureHash)
}
try {
  writeFileSync(source, before)
  for (const state of ['rollover', 'bracket']) run('red', state, 1)
  run('red', '', 1, rookieFixture)
} finally {
  writeFileSync(source, fixed)
  assert.equal(hash(readFileSync(source)), hash(fixed))
}
for (const state of ['rollover', 'bracket', '']) run('green', state, 0)
run('green', '', 0, rookieFixture)
writeFileSync(path.join(evidence, 'review4/red-green.json'), JSON.stringify({ provenance: 'SYNTHETIC', fixtureHash, rookieFixtureHash, beforeHash: hash(before), restoredHash: hash(fixed), results }, null, 2)+'\n')
console.log('Final fixture proves rollover and bracket stalls before the fix, recovery after it, and unchanged fixture/source hashes.')
