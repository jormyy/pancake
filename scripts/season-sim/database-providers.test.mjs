import assert from 'node:assert/strict'
import test from 'node:test'
import { sleeperSnapshot,providerSnapshot } from './database-providers.mjs'

test('the database provider fixture uses only known active identities',()=>{
  const row={sleeper_id:'123',first_name:'Stored',last_name:'Player',nba_team:'BOS',position:'PG',years_exp:4}
  const result=sleeperSnapshot([row,{...row,sleeper_id:null},{...row,sleeper_id:'124',nba_team:null}])
  assert.equal(result.provenance,'SYNTHETIC')
  assert.deepEqual(Object.keys(result.players),['123'])
  assert.equal(result.players['123'].years_exp,4)
  assert.throws(()=>sleeperSnapshot([row,row]))
  assert.throws(()=>sleeperSnapshot([]))
  assert.throws(()=>sleeperSnapshot([{...row,first_name:null}]))
})

test('the database roster uses current names and preserves completed experience years',()=>{
  const row={id:'owner',sleeper_id:'123',espn_id:'234',nba_id:'345',first_name:'Stored',last_name:'Player',nba_team:'BOS',position:'PG',years_exp:4,birthdate:'1990-01-01'}
  const result=providerSnapshot([row,{...row,sleeper_id:null,espn_id:null,nba_id:'456',nba_team:null}],2027)
  assert.equal(result.espn[0].id,'234')
  assert.equal(result.espn[0].experience.years,5)
  assert.deepEqual(result.nbaIndex.resultSets[0].rowSet[0],[345,'Stored','Player',1,'BOS','PG',2022])
  assert.equal(result.nbaIndex.resultSets[0].rowSet[1][3],0)
  const projected=providerSnapshot([row],2027,[{player_id:'owner',sleeper_id:'123',source_game_id:'789',game_date:'2026-10-29',team:'BOS',opponent:'NYK',week_number:2,season_year:2027,last_modified:1000,points:12,minutes:20}])
  assert.equal(projected.projections[0].stats.pts,12)
  assert.equal(projected.projections[0].stats.sp,1200)
  assert.equal(projected.projections[0].season,'2026')
})
