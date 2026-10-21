import assert from 'node:assert/strict'
import test from 'node:test'
import { twoPlan, areaCheck, draftSourceUnavailable } from './two-checks.mjs'

test('legacy runs do not select the real two-season leg implicitly', async () => {
  assert.equal(await twoPlan(), null)
})

test('a missing rookie game is an area failure rather than an unmeasured result', () => {
  assert.throws(() => areaCheck('rookie-identity', () => assert.fail('Missing rookie game')), error => error instanceof Error&&'area' in error&&error.area === 'rookie-identity')
})

test('declared draft input unavailability cannot hide an unrelated worker failure',()=>{
  const time=Date.parse('2025-06-20T13:00:00Z'),available='2025-06-28T00:00:00Z'
  assert.ok(draftSourceUnavailable('sync-draft-order',time,available,'Could not load a complete board. NBA.com 503'))
  assert.equal(draftSourceUnavailable('sync-draft-order',time,available,'SQL syntax error'),false)
  assert.equal(draftSourceUnavailable('sync-draft-order',Date.parse(available),available,'Could not load a complete board. 503'),false)
})
