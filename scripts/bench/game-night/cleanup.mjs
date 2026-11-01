import assert from 'node:assert/strict'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {stopRecordedStack} from './stack.mjs'

const {values}=parseArgs({options:{help:{type:'boolean'},evidence:{type:'string'},project:{type:'string'}}})
if(values.help)console.log('Usage: node scripts/bench/game-night/cleanup.mjs --evidence DIRECTORY --project RECORDED_PROJECT')
else {
  assert.ok(values.evidence && values.project,'Evidence directory and recorded project are required')
  await stopRecordedStack(path.resolve(values.evidence),values.project)
  console.log('The recorded disposable stack is stopped.')
}
