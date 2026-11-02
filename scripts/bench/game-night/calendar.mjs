import assert from 'node:assert/strict'
import { delay } from './common.mjs'

export function fixtureDate(time) {
  return new Date(time).toLocaleDateString('en-CA',{timeZone:'America/New_York'})
}

export async function waitForFixtureDay({now=Date.now,sleep=delay,announce=console.log,duration=45*60000}={}) {
  assert.ok(Number.isFinite(duration) && duration>0 && duration<86400000,'A replay must fit within one fixture day')
  let waiting=false
  while(fixtureDate(now())!==fixtureDate(now()+duration)) {
    if(!waiting)announce('Waiting for a stable fixture date before starting the replay.')
    waiting=true
    await sleep(50000)
  }
  if(waiting)announce('The fixture date is stable; replay preparation resumes.')
  return fixtureDate(now())
}
