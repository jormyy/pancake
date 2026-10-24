import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from './common.mjs'
import { clearOwnBackup } from './local-stack.mjs'

test('fresh reset removes only a backup with the exact lane name and project label', async () => {
  const calls = []
  assert.equal(await clearOwnBackup(async (method, resource) => {
    calls.push([method, resource])
    return Buffer.from(JSON.stringify({ Name: config.container, Labels: { 'com.supabase.cli.project': config.project } }))
  }), true)
  assert.deepEqual(calls, [['GET', `/volumes/${config.container}`], ['DELETE', `/volumes/${config.container}`]])
  const methods = []
  await assert.rejects(clearOwnBackup(async method => {
    methods.push(method)
    return Buffer.from(JSON.stringify({ Name: config.container, Labels: { 'com.supabase.cli.project': 'another-project' } }))
  }), /configured project/)
  assert.deepEqual(methods, ['GET'])
})

test('an absent backup is safe and unexpected inspection failures stop reset', async () => {
  assert.equal(await clearOwnBackup(async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }) }), false)
  await assert.rejects(clearOwnBackup(async () => { throw new Error('unavailable') }), /unavailable/)
})
