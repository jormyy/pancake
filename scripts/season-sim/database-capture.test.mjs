import assert from 'node:assert/strict'
import test from 'node:test'
import { configurePlanCapture } from './database-capture.mjs'

test('capture starts after preparation and can be disabled before cleanup', async () => {
  const commands = []
  const execute = async command => commands.push(command)
  await configurePlanCapture({ project: 'pt4bafabledb', execute, enabled: true })
  await configurePlanCapture({ project: 'pt4bafabledb', execute, enabled: false })
  assert.deepEqual(commands, ["LOAD 'auto_explain'; RESET auto_explain.log_min_duration;", "ALTER SYSTEM SET auto_explain.log_min_duration='0'", 'SELECT pg_reload_conf()', "ALTER SYSTEM SET auto_explain.log_min_duration='-1'", 'SELECT pg_reload_conf()'])
})

test('capture rejects another project before executing SQL', async () => {
  const commands = []
  await assert.rejects(configurePlanCapture({ project: 'another-project', execute: async command => commands.push(command), enabled: true }), /private database project/)
  assert.deepEqual(commands, [])
})
