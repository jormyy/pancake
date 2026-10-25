import assert from 'node:assert/strict'
import test from 'node:test'
import { assertFetchTarget } from './fetch-guard.mjs'
import {originUrl}from'./common.mjs'

test('the real Edge fetch guard fails closed outside exact task HTTP origins',()=>{
  assert.equal(assertFetchTarget(`${originUrl('replay')}/push`).pathname,'/push')
  for(const target of ['https://exp.host/--/api/v2/push/send','http://example.test:57280/push','https://127.0.0.1:57280/push','http://127.0.0.1:54321/','http://user:secret@127.0.0.1:57280/push','https://ceeytbfmwsnzalxlkalc.supabase.co'])assert.throws(()=>assertFetchTarget(target))
})
