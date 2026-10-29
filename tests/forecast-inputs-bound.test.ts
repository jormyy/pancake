import { expect, it } from 'vitest'
import { enforceTiming, nestedPlans } from './db/forecast-inputs-bound.mjs'

it.each([299, 300, 1000])('checks the forecast call bound at %i ms', milliseconds => {
  const run = () => enforceTiming([{ matchup_id: 'matchup', kind: 'prepare_cold', milliseconds, shared_hit: 20, shared_read: 0 }])
  if (milliseconds < 300) expect(run).not.toThrow()
  else expect(run).toThrow('Forecast p95 exceeds 300 ms')
})

it('rejects a slow statement even when call p95 passes', () => {
  expect(() => enforceTiming([], [{ milliseconds: 1000, query: 'slow statement' }])).toThrow('Forecast statement exceeds 1 s')
})

it('rejects a single timeout hidden by the percentile', () => {
  const samples = Array.from({ length: 30 }, (_, index) => ({ matchup_id: 'matchup', kind: 'prepare_cold', milliseconds: index === 0 ? 1000 : 20, shared_hit: 20, shared_read: 0 }))
  expect(() => enforceTiming(samples)).toThrow('Forecast call exceeds 1 s')
})

it('reads nested statement timing and buffers', () => {
  const plans = nestedPlans('NOTICE:  duration: 42.125 ms  plan:\n{"Query Text":"SELECT \'{quoted}\'", "Plan":{"Shared Hit Blocks":23,"Shared Read Blocks":4}}\nCONTEXT: SQL statement')
  expect(plans).toMatchObject([{ milliseconds: 42.125, sharedHit: 23, sharedRead: 4, query: "SELECT '{quoted}'" }])
})
