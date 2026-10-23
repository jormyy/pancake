import assert from'node:assert/strict'
import test from'node:test'
import{openingCutoff,openingJumps,draftProbePlan}from'./draft-probe.mjs'

test('opening-night cutoff follows Eastern business time through DST',()=>{
  assert.equal(new Date(openingCutoff('2025-10-21')).toISOString(),'2025-10-21T13:00:00.000Z')
  assert.equal(new Date(openingCutoff('2025-11-03')).toISOString(),'2025-11-03T14:00:00.000Z')
})


test('separate bounded draft phases cannot silently select another scenario',()=>{
  assert.deepEqual(draftProbePlan('turns'),{turns:true,cutoff:false})
  assert.deepEqual(draftProbePlan('cutoff'),{turns:false,cutoff:true})
  assert.throws(()=>draftProbePlan('full-replay'))
})

test('opening-night jumps follow the first 002 game day and its 09:00 ET boundary',()=>{
  assert.deepEqual(openingJumps('2025-10-21'),{eve:'2025-10-20T09:59:00Z',eveSettled:'2025-10-20T10:10:00Z',beforeBoundary:'2025-10-21T12:59:00Z',afterBoundary:'2025-10-21T13:16:00Z'},'The real 2025-26 opening keeps the pinned instants')
  assert.deepEqual(openingJumps('2026-11-03'),{eve:'2026-11-02T10:59:00Z',eveSettled:'2026-11-02T11:10:00Z',beforeBoundary:'2026-11-03T13:59:00Z',afterBoundary:'2026-11-03T14:16:00Z'},'An opening after the clock change keeps the ET wall times')
})
