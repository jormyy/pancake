import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('the waiver catalog builds without the removed season FAAB helper and keeps its retired identifier', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'waiver-catalog-'))
  try {
    const output = path.join(directory, 'catalog.json')
    execFileSync('/usr/bin/python3', ['scripts/mutation/waivers/build_catalog.py', output])
    const catalog = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(catalog.mutants.find(row => row.id === 'waiv-faab-11')?.retired, true)
    assert.equal(catalog.mutants.find(row => row.id === 'waiv-faab-12')?.symbol, 'public.commissioner_adjust_faab_balance_atomic')
    assert.equal(catalog.mutants.find(row => row.id === 'waiv-waiver-order-13')?.retired, true)
    const scheduled = catalog.mutants.find(row => row.original === "AND (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') <= now()")
    assert.ok(scheduled && !scheduled.retired, 'The scheduled claim boundary needs an active mutation')
    assert.equal(scheduled.symbol, 'public.process_next_waiver_claim_atomic')
    assert.equal(scheduled.mutated, "AND (candidate.process_date + time '00:00') AT TIME ZONE coalesce(claim_league.timezone, 'America/Los_Angeles') < now()")
    assert.equal(new Set(catalog.mutants.map(row => row.id)).size, catalog.mutants.length)
    const consumer = await readFile('scripts/mutation/waivers/run.py', 'utf8')
    const fields = consumer.match(/row = \{k:mutant\[k\] for k in \(([^)]+)\)\}/)[1].match(/'([^']+)'/g).map(field => field.slice(1, -1))
    for (const mutant of catalog.mutants.filter(row => row.retired)) for (const key of fields) assert.ok(Object.hasOwn(mutant, key), `${mutant.id} lacks invalid-result field ${key}`)
    assert.ok(catalog.mutants.filter(row => !row.retired).length > 50)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
