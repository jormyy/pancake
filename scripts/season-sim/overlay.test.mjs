import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyOverlay } from './overlay.mjs'

test('explicit SQL overlay records changed definitions after restore and rejects connection commands', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'season-overlay-'))
  const file = path.join(directory, 'mutant.sql'), calls = []
  let definition = 'baseline'
  const execute = async query => {
    calls.push(query)
    if (query.startsWith('SELECT')) return definition
    definition = query
    return ''
  }
  try {
    await writeFile(file, 'CREATE OR REPLACE FUNCTION mutant() RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;')
    const result = await applyOverlay(file, execute)
    assert.notEqual(result.before, result.after)
    assert.equal(calls.length, 3)
    assert.match(result.appliedAfter, /runtime startup/)
    await assert.rejects(applyOverlay('relative.sql', execute), /absolute/)
    await writeFile(file, '\\connect forbidden')
    await assert.rejects(applyOverlay(file, execute), /not psql/)
    assert.equal(calls.length, 3)
  } finally { await rm(directory, { recursive: true }) }
})
