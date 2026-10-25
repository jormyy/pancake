import assert from 'node:assert/strict'
import test from 'node:test'
import { apiTarget, databaseTarget } from './targets.mjs'

test('CI status URLs work without port overrides', () => {
  assert.equal(databaseTarget({ SUPABASE_DB_URL: 'postgresql://postgres@127.0.0.1:54322/postgres' }).port, '54322')
  assert.equal(apiTarget({ SUPABASE_URL: 'http://127.0.0.1:54321' }).port, '54321')
})

test('explicit lane ports accept both local host names', () => {
  assert.equal(databaseTarget({ SUPABASE_DB_URL: 'postgresql://postgres@localhost:57622/postgres', PANCAKE_TEST_DB_PORT: '57622' }).port, '57622')
  assert.equal(apiTarget({ E2E_SUPABASE_URL: 'http://127.0.0.1:57621', PANCAKE_TEST_API_PORT: '57621' }).port, '57621')
})

test('wrong ports, hosts, protocols, and invalid expected ports fail before clients start', () => {
  for (const url of ['postgresql://localhost:57622/postgres', 'postgresql://example.invalid:54322/postgres', 'https://localhost:54322/postgres']) {
    assert.throws(() => databaseTarget({ SUPABASE_DB_URL: url }))
  }
  for (const url of ['http://localhost:57621', 'http://example.invalid:54321', 'ftp://localhost:54321']) {
    assert.throws(() => apiTarget({ SUPABASE_URL: url }))
  }
  for (const port of ['0', '65536', '-1', 'NaN']) {
    assert.throws(() => databaseTarget({ SUPABASE_DB_URL: 'postgresql://localhost:54322/postgres', PANCAKE_TEST_DB_PORT: port }))
  }
})
