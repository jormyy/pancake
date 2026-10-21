import assert from'node:assert/strict'
import test from'node:test'
import{openingCutoff,draftProbePlan}from'./draft-probe.mjs'

test('opening-night cutoff follows Eastern business time through DST',()=>{
  assert.equal(new Date(openingCutoff('2025-10-21')).toISOString(),'2025-10-21T13:00:00.000Z')
  assert.equal(new Date(openingCutoff('2025-11-03')).toISOString(),'2025-11-03T14:00:00.000Z')
})


test('separate bounded draft phases cannot silently select another scenario',()=>{
  assert.deepEqual(draftProbePlan('turns'),{turns:true,cutoff:false})
  assert.deepEqual(draftProbePlan('cutoff'),{turns:false,cutoff:true})
  assert.throws(()=>draftProbePlan('full-replay'))
})
