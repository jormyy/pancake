import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/post')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const source = 'supabase/functions/_shared/seasonBoundary.ts'
const fixture = 'supabase/tests/db/rookie-skipped-week.ts'
const evidence = path.join(lane, 'evidence')
const before = readFileSync(path.join(evidence, 'review3/seasonBoundary-before.ts'), 'utf8')
assert.ok(before.includes(".eq('week_number', 1)"))
const fixed = readFileSync(source, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const fixtureHash = hash(readFileSync(fixture))
const results = []
const run = (name, expected) => {
  const command = `node scripts/mutation/post/check.mjs ${fixture}`
  const result = spawnSync('node', ['scripts/mutation/post/check.mjs', fixture], { encoding: 'utf8', timeout: 120_000 })
  const log = path.join(evidence, name)
  mkdirSync(path.dirname(log), { recursive: true })
  writeFileSync(log, `${command}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit=${result.status}\n`)
  results.push({ command, exit: result.status, log })
  assert.equal(result.status, expected, log)
  assert.equal(hash(readFileSync(fixture)), fixtureHash)
}
try {
  writeFileSync(source, before)
  run('red/rookie-skipped-week-final.log', 1)
} finally {
  writeFileSync(source, fixed)
  assert.equal(hash(readFileSync(source)), hash(fixed))
}
run('green/rookie-skipped-week-final.log', 0)
writeFileSync(path.join(evidence, 'review3/red-green.json'), JSON.stringify({ provenance: 'SYNTHETIC', fixtureHash, beforeHash: hash(before), restoredHash: hash(fixed), results }, null, 2)+'\n')
console.log('Final fixture fails before the timing fix and passes after it; source and fixture hashes verified.')
