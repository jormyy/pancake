import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readJson, id } from './common.mjs'
import { fantasyAt } from './measure.mjs'
import { phoneGrade } from './phone-grade.mjs'

const slate=await readJson(new URL('./training.json',import.meta.url))
const started=1000000,ended=started+slate.windowSeconds*1000
function fixture() {
  const renders=[]
  const phones=Array.from({length:10},(_,index)=>{
    const member=id(201+index)
    let display
    for(let second=0;second<=slate.windowSeconds;second+=10) {
      const match=fantasyAt(slate,second).find(row=>[row.home_member_id,row.away_member_id].includes(member))
      display={phone:index+1,at:started+second*1000+1000,homeMemberId:match.home_member_id,awayMemberId:match.away_member_id,
        homePoints:match.home_points,awayPoints:match.away_points,stale:false}
      renders.push(display)
    }
    return {phone:index+1,ready:true,error:null,broadcasts:1,display}
  })
  return {slate,started,ended,renders,phones,requests:[],reads:[],messages:phones.map(phone=>({phone:phone.phone,at:started+1000,score:true,bytes:100}))}
}
test('ten correct phone histories pass and a dropped final value fails',()=>{
  const data=fixture()
  assert.equal(phoneGrade(data).passed,true)
  data.phones[0].display.homePoints++
  assert.equal(phoneGrade(data).gates.finalScores.passed,false)
})
test('late phone scores and a missing Realtime subscriber each fail',()=>{
  const late=fixture()
  late.renders=late.renders.map(row=>({...row,at:row.at+60000}))
  assert.equal(phoneGrade(late).gates.freshness.passed,false)
  const disconnected=fixture()
  disconnected.messages=disconnected.messages.filter(row=>row.phone!==1)
  assert.equal(phoneGrade(disconnected).gates.realtime.passed,false)
})
test('broadcasts from warmup cannot pass the timed work gate',()=>{
  const data=fixture()
  data.messages=data.messages.map(row=>({...row,at:started-1}))
  assert.equal(phoneGrade(data).gates.realtime.passed,false)
})
