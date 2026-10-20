import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSqlSession } from './sql-session.mjs'

test('SQL session serializes requests and preserves multiline values', async () => {
  const session = createSqlSession(process.execPath, process.env, [fileURLToPath(new URL('./sql-session-fixture.mjs', import.meta.url))])
  try {
    assert.deepEqual(await Promise.all([session.query('one'), session.query('two\nthree')]), ['one', 'two\nthree'])
    await assert.rejects(session.query('FAIL'), /exits 3: deliberate failure/)
    assert.equal(await session.query('reconnected'), 'reconnected')
  } finally { await session.close() }
})
