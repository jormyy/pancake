import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureDate, waitForFixtureDay } from './calendar.mjs'

test('the fixture date follows Eastern standard and daylight time',()=>{
  assert.equal(fixtureDate(Date.parse('2026-01-15T05:30:00Z')),'2026-01-15')
  assert.equal(fixtureDate(Date.parse('2026-07-15T04:30:00Z')),'2026-07-15')
})

test('a replay waits through midnight instead of changing its fixture day mid-run',async()=>{
  for(const initial of ['2026-01-15T04:55:00Z','2026-07-15T03:55:00Z']) {
    let time=Date.parse(initial),sleeps=0
    const messages=[]
    const day=await waitForFixtureDay({now:()=>time,sleep:async()=>{time+=60000;sleeps++},announce:line=>messages.push(line)})
    assert.equal(sleeps,5)
    assert.equal(day,'2026-'+(initial.includes('01-')?'01':'07')+'-15')
    assert.equal(messages.length,2)
  }
})

test('a stable window starts without a wait and invalid windows fail',async()=>{
  let sleeps=0
  assert.equal(await waitForFixtureDay({now:()=>Date.parse('2026-01-15T12:00:00Z'),sleep:async()=>{sleeps++}}),'2026-01-15')
  assert.equal(sleeps,0)
  await assert.rejects(waitForFixtureDay({duration:86400000}),/one fixture day/)
})


test('the complete paired series waits when its four-hour allowance crosses midnight',async()=>{
  let time=Date.parse('2026-01-15T02:00:00Z'),sleeps=0
  const day=await waitForFixtureDay({duration:4*60*60*1000,now:()=>time,sleep:async()=>{time+=60000;sleeps++},announce:()=>{}})
  assert.equal(sleeps,180)
  assert.equal(day,'2026-01-15')
})
