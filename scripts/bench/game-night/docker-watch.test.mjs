import assert from 'node:assert/strict'
import test from 'node:test'
import {containerStart} from './docker-watch.mjs'

test('short-lived foreign starts are recorded even between samples',()=>{
  const event={Type:'container',Action:'start',time:100,timeNano:100001000000,Actor:{ID:'control',Attributes:{name:'short-control',image:'local', 'com.supabase.cli.project':'foreign'}}}
  assert.equal(containerStart(event,'own').name,'short-control')
  assert.equal(containerStart(event,'foreign'),null)
  assert.equal(containerStart({...event,Action:'stop'},'own'),null)
  assert.equal(containerStart({...event,Type:'image'},'own'),null)
})
