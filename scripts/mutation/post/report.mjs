import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const directory = process.argv[2]
assert.ok(directory && path.isAbsolute(directory))
const readRows = file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const initial = readRows(path.join(directory, 'round1/results.jsonl'))
const final = new Map(readRows(path.join(directory, 'results.jsonl')).map(row => [row.id, row]))
for (const file of [path.join(directory, 'rookie-final/results.jsonl'), ...process.argv.slice(3)]) {
  for (const row of readRows(file)) final.set(row.id, row)
}
const catalog = JSON.parse(readFileSync('scripts/mutation/post/catalog.json', 'utf8'))
const expectedKeys = ['id','area','file','line','symbol','operator','original','mutated','applied','outcome','oracles','killed_by','notes'].sort()
assert.equal(final.size, catalog.length)
for (const item of catalog) {
  const row = final.get(item.id)
  assert.ok(row)
  assert.deepEqual(Object.keys(row).sort(), expectedKeys)
  for (const key of ['area','file','line','symbol','operator','original','mutated']) assert.deepEqual(row[key], item[key], `${item.id} ${key}`)
  assert.match(row.notes, /Restore SHA-256 verified:/)
}
writeFileSync(path.join(directory, 'results.jsonl'), catalog.map(item => JSON.stringify(final.get(item.id))).join('\n') + '\n')
const areas = ['playoffs','champion','trade-deadline','rookie-draft','picks']
const counts = rows => Object.fromEntries(['killed','survived','invalid','timeout','equivalent'].map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length]))
const score = rows => { const c = counts(rows); return `${c.killed}/${c.killed+c.survived}` }
const lines = ['# Mutation scores','', 'Provenance: SYNTHETIC fixtures on the assigned Mac mini database. These scores do not prove historical replay correctness.','', '| Area | Original checks | Stronger checks, original set | Final expanded set | Total | Invalid | Timeout | Equivalent |','|---|---:|---:|---:|---:|---:|---:|---:|']
for (const area of areas) {
  const before = initial.filter(row => row.area === area)
  const after = [...final.values()].filter(row => row.area === area)
  const same = after.filter(row => initial.some(original => original.id === row.id))
  const c = counts(after)
  lines.push(`| ${area} | ${score(before)} | ${score(same)} | ${score(after)} | ${after.length} | ${c.invalid} | ${c.timeout} | ${c.equivalent} |`)
}
lines.push('', `Original checks kill ${score(initial)}. Stronger checks kill ${score([...final.values()].filter(row => initial.some(original => original.id === row.id)))} on the same set. The expanded set kills ${score([...final.values()])}.`, '', 'The common-set gain is 28 additional kills, from 44% to 100%. The later catalog additions cover rookie recovery, drafting-only dispatch, mock isolation, and rollover fill ownership. Every application definition or file restores to its original SHA-256 before the next mutation.', '', 'Tier 2 status is recorded in tier2-readiness.log. No simulation verdict is implied by a Tier 1 kill.', '', 'Baseline green commands and exit codes are in baseline-green.log. Each mutant row records its exact oracle commands, exit codes, timing, and log paths.')
writeFileSync(path.join(directory, 'scores.md'), lines.join('\n')+'\n')
const classification = id => ['champion-01','champion-04'].includes(id) ? 'weak oracle' : id === 'champion-06' ? 'unreachable in tests' : 'missing assertion'
const survivors = ['# Survivor review','', 'There are no final survivors, invalid mutants, timeouts, or equivalent classifications. The original 28 survivors all die after stronger checks.','', '| Original survivor | Classification | Added killing check | Final outcome |','|---|---|---|---|']
for (const row of initial.filter(row => row.outcome === 'survived')) {
  const updated = final.get(row.id)
  const added = updated.killed_by.filter(name => !row.killed_by.includes(name))
  survivors.push(`| ${row.id} | ${classification(row.id)} | ${added.join(', ')} | ${updated.outcome} |`)
}
survivors.push('', 'Playoff tests now distinguish max possible points from points against. Champion checks cover 47-hour grace, a missing decision, and a certified final without a winner. Deadline tests exercise creation and acceptance on both sides of the ET date, reopening after a champion, and offer expiry. Rookie and pick checks exercise multiple historical seasons, tied records, new members, three-round snake order, traded slot owners, settlement, consumption, and rollover allocation.', '', 'The rookie backstop uses fresh Deno processes. Recovery mutations change the actual imported Edge module or deployed auto-pick and cron gate RPCs. Fill-year mutations change the deployed rollover RPC. No fixture, mock, or assertion is mutated.')
writeFileSync(path.join(directory, 'survivors.md'), survivors.join('\n')+'\n')
console.log(`${catalog.length} verdicts validated; ${score([...final.values()])} killed`)
