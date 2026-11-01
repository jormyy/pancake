import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readJson, id } from './common.mjs'
import { fantasyAt } from './measure.mjs'
import { phoneGrade } from './phone-grade.mjs'
import { stateAt } from './fixture.mjs'

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
        homePoints:match.home_points,awayPoints:match.away_points,stale:false,mode:'public'}
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
test('a thirty-second refresh can include a newer change without displaying every twenty-second frame',()=>{
  const data=fixture()
  data.renders=data.renders.filter(row=>(row.at-started-1000)%30000===0)
  assert.equal(phoneGrade(data).gates.freshness.passed,true)
})
test('every phone needs each official final line and one corrupted final line fails',()=>{
  const data=fixture()
  const line=player=>{
    const s=player.statistics
    return [String(player.personId),s.points,s.reboundsTotal,s.assists,s.steals,s.blocks,s.turnovers,s.threePointersMade,
      s.fieldGoalsMade,s.fieldGoalsAttempted,s.freeThrowsMade,s.freeThrowsAttempted,s.foulsPersonal,25,0]
  }
  const games=seconds=>stateAt(slate,seconds).map(game=>({id:game.nba_game_id,nbaId:game.nba_game_id,source:'nba',
    status:game.gameStatus===3?'Final':'InProgress',home:{team:game.home,score:game.homeTeam.score,players:game.homeTeam.players.map(line)},
    away:{team:game.away,score:game.awayTeam.score,players:game.awayTeam.players.map(line)}}))
  data.architecture=true
  data.frames=data.phones.flatMap(phone=>[1,121].map(second=>({phone:phone.phone,at:started+second*1000,snapshot:{games:games(second)}})))
  data.finalGameChecks=stateAt(slate,240).filter(game=>game.gameStatus===3).map(game=>({gameId:game.id,passed:true}))
  assert.equal(phoneGrade(data).gates.finalHandoffs.passed,true)
  data.frames.find(frame=>frame.phone===1 && frame.at===started+121000).snapshot.games[2].home.players[0][1]++
  assert.equal(phoneGrade(data).gates.finalHandoffs.passed,false)
  data.frames[0].snapshot.games[0].home.players[0][1]++
  data.finalGameChecks[0].passed=false
  assert.equal(phoneGrade(data).gates.finalHandoffs.passed,false)
})
