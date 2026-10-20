import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sqlJson } from './local-stack.mjs'

const query = 'SELECT coalesce(json_agg(m),\'[]\') FROM matchups m WHERE false'
const context = 'matchups league=test date=2026-03-23'

test('an explicit empty JSON array remains distinct from an empty SQL read', async () => {
  assert.deepEqual(await sqlJson(query, context, async () => '[]'), [])
  for (const output of ['', ' \n']) await assert.rejects(sqlJson(query, context, async () => output), /matchups league=test date=2026-03-23: empty SQL output/)
})

test('malformed SQL JSON reports the query context without returning a fallback', async () => {
  await assert.rejects(sqlJson(query, context, async () => '[{"id":'), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /matchups league=test date=2026-03-23: invalid SQL JSON/)
    assert.ok(error.cause instanceof SyntaxError)
    return true
  })
})

test('failed SQL reads retain the cause and query context', async () => {
  const failure = new Error('psql exited 1')
  await assert.rejects(sqlJson(query, context, async () => { throw failure }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /matchups league=test date=2026-03-23: SQL read failed/)
    assert.equal(error.cause, failure)
    return true
  })
})
