import assert from 'node:assert/strict'
import test from 'node:test'
import { advancePhoneVersion, phoneChange } from './phone-read.mjs'

test('phone versions advance without regressing to an older screen or hint',()=>{
  assert.equal(advancePhoneVersion('20','21'),'21')
  for(const value of ['19',undefined,'-1','9223372036854775808','3x',Infinity])assert.equal(advancePhoneVersion('20',value),'20')
})

test('phones consume authorized version hints and action invalidations',()=>{
  const version={payload:{league_id:'league',topic:'version',details:[{version:'31',scope:{},topic:'score',created_at:'2026-11-01T00:00:00Z'}]}}
  assert.deepEqual(phoneChange(version,'league'),{refresh:true,version:'31'})
  assert.equal(phoneChange(version,'another').refresh,false)
  for(const topic of ['lineup','roster','score','game','stat','player_stats','inventory','resources'])assert.equal(phoneChange({payload:{league_id:'league',topic}},'league').refresh,true)
  version.payload.details[0].version='invalid'
  assert.equal(phoneChange(version,'league').refresh,false)
})
