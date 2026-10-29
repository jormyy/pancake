import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { labTarget } from '../../scripts/perf-lab/target.mjs'

const source = readFileSync('scripts/perf-lab/two-day.mjs', 'utf8')
const guard = source.match(/^\s*assert\.equal\(config\.prefix,[^\n]+$/m)?.[0]
assert.ok(guard)

it.each(['572', '623', '632'])('accepts the configured replay port block %s', prefix => {
  const target = labTarget({ NODE_ENV: 'test', PERF_LAB_LANE: 'fable-l4', PERF_LAB_PROJECT: 'pt4bafablel4', PERF_LAB_PORT_PREFIX: prefix })
  expect(() => runInNewContext(guard, { assert, config: { prefix }, target })).not.toThrow()
})

it('rejects a replay configured for a different private port block', () => {
  const target = labTarget({ NODE_ENV: 'test', PERF_LAB_LANE: 'fable-l4', PERF_LAB_PROJECT: 'pt4bafablel4', PERF_LAB_PORT_PREFIX: '623' })
  expect(() => runInNewContext(guard, { assert, config: { prefix: '572' }, target })).toThrow()
})
