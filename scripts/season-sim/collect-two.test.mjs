import assert from 'node:assert/strict'
import test from 'node:test'
import {sourceProblems} from './collect-two.mjs'

test('an empty successful archive query is still an unavailable historical source',()=>{
  const result=sourceProblems([{status:403,kind:'nba-schedule',bytes:200},{status:200,kind:'archive-index',bytes:3},{status:200,kind:'nba-schedule',bytes:4000000}])
  assert.equal(result.failedFetches.length,1)
  assert.equal(result.unavailableArchives.length,1)
})
