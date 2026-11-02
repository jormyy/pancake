import { throws } from 'node:assert/strict'
import type { NBABoxScore, NBABoxScorePlayer } from './nba.ts'
Deno.env.set('SUPABASE_URL','http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY','fixture-key')
const {validateBoxScorePlayers}=await import('./syncStats.ts')
const player=(personId:number,points:number):NBABoxScorePlayer=>({personId,name:`Player ${personId}`,played:'1',statistics:{
  assists:0,blocks:0,fieldGoalsAttempted:0,fieldGoalsMade:0,foulsPersonal:0,freeThrowsAttempted:0,freeThrowsMade:0,
  minutes:'PT10M00S',plusMinusPoints:0,points,reboundsDefensive:0,reboundsOffensive:0,reboundsTotal:0,steals:0,
  threePointersAttempted:0,threePointersMade:0,turnovers:0,
}})
const box=():NBABoxScore=>({gameId:'0021',gameEt:null,gameStatus:3,
  homeTeam:{teamTricode:'BOS',score:12,players:[player(1,10)]},awayTeam:{teamTricode:'NYK',score:8,players:[player(2,8)]}})
Deno.test('a final missing scored points is held instead of certified',()=>{
  throws(()=>validateBoxScorePlayers(box(),'0021'),/total|score/i)
})
Deno.test('a final cannot mark a player with real points as DNP',()=>{
  const value=box();value.homeTeam.score=10;value.homeTeam.players[0].played='0'
  throws(()=>validateBoxScorePlayers(value,'0021'),/DNP|participation/i)
})
Deno.test('a final cannot convert malformed played minutes into DNP',()=>{
  const value=box();value.homeTeam.score=10;value.homeTeam.players[0].statistics.minutes='broken'
  throws(()=>validateBoxScorePlayers(value,'0021'),/minutes|incomplete/i)
})
