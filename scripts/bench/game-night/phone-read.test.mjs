import assert from 'node:assert/strict'
import test from 'node:test'
import { advancePhoneVersion, phoneChange } from './phone-read.mjs'

const version={topic:'version',details:[{version:'31',scope:{},topic:'score',created_at:'2026-11-01T00:00:00Z'}]}
const batch=row=>({payload:{hints:[{event:'UPDATE',row}]}})

test('phone versions advance without regressing to an older screen or hint',()=>{
  assert.equal(advancePhoneVersion('20','21'),'21')
  for(const value of ['19',undefined,'-1','9223372036854775808','3x',Infinity])assert.equal(advancePhoneVersion('20',value),'20')
})

test('phones decode the same batch and table-change envelopes as the app',()=>{
  assert.deepEqual(phoneChange(batch(version),'league','30'),{refresh:true,version:'31'})
  const table={payload:{schema:'public',table:'league_change_hints',eventType:'UPDATE',new:{league_id:'league',...version}}}
  assert.deepEqual(phoneChange(table,'league','30'),{refresh:true,version:'31'})
  assert.deepEqual(phoneChange(table,'league','31'),{refresh:false,version:'31'})
  for(const topic of ['lineup','roster','score','game','stat','player_stats','inventory','resources'])assert.equal(phoneChange(batch({topic}),'league').refresh,true)
})

test('foreign, deleted and invalid hints do not refresh a screen',()=>{
  assert.equal(phoneChange(batch({league_id:'foreign',...version}),'league').refresh,false)
  assert.equal(phoneChange({payload:{hints:[{event:'DELETE',row:version}]}},'league').refresh,false)
  assert.equal(phoneChange(batch({topic:'version',details:[{...version.details[0],version:'invalid'}]}),'league').refresh,false)
  assert.equal(phoneChange({payload:{league_id:'league',topic:'score'}},'league').refresh,false)
  assert.equal(phoneChange({payload:{schema:'private',table:'league_change_hints',eventType:'UPDATE',new:{league_id:'league',...version}}},'league').refresh,false)
})
