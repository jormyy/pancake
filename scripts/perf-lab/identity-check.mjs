import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from './database.mjs'
import { json } from './common.mjs'

export async function checkIdentity(expected, evidence, execute = sql) {
  assert.ok(['split', 'linked'].includes(expected), 'Unknown identity expectation')
  let failure = null
  try { await execute(await readFile(new URL('../../tests/perf-lab/player-identities.sql', import.meta.url), 'utf8')) }
  catch (error) { failure = error.message }
  if (expected === 'split') assert.ok(failure?.includes('Complementary null-team source identities stay split'), `The old identity rule did not fail as expected: ${failure ?? 'no failure'}`)
  else assert.equal(failure, null, failure)
  if (expected === 'linked') await execute(await readFile(new URL('../../tests/db/player-source-connectivity.sql', import.meta.url), 'utf8'))
  const result = { expected, passed: true, checks: expected === 'split' ? 1 : 16, negativeControl: expected === 'split', observedFailure: failure }
  await json(path.join(evidence, 'identity-test.json'), result)
  if (expected === 'linked') {
    const history = (await readFile(new URL('../../tests/e2e/release-schema-history.sql', import.meta.url), 'utf8'))
      .replace("'statementCount', cardinality(m.statements),", "'statements', m.statements, 'statementCount', cardinality(m.statements),")
    await json(path.join(evidence, 'migration-history.json'), JSON.parse(await execute(history)))
    const catalog = await readFile(new URL('../../tests/e2e/db-security-catalog.sql', import.meta.url), 'utf8')
    await json(path.join(evidence, 'security-catalog.json'), JSON.parse(await execute(`SET search_path=public,extensions;\n${catalog}`)))
  }
  return result
}
