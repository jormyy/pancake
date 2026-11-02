import assert from 'node:assert/strict'
import test from 'node:test'
import { advancePhoneVersion, phoneChange } from './phone-read.mjs'

const version={topic:'version',details:[{version:'31',scope:{},topic:'score',created_at:'2026-11-01T00:00:00Z'}]}
const batch=row=>({payload:{hints:[{event:'UPDATE',row}]}})

test('phone versions advance without regressing to an older screen or hint',()=>{
  assert.equal(advancePhoneVersion('20','21'),'21')
  for(const value of ['19',undefined,'-1','9223372036854775808','3x',Infinity])assert.equal(advancePhoneVersion('20',value),'20')
})

test('phones decode the same batch and table-change envelopes as the app',()=>{
  assert.deepEqual(phoneChange(batch(version),'league','30'),{refresh:true,version:'31'})
  const table={payload:{schema:'public',table:'league_change_hints',eventType:'UPDATE',new:{league_id:'league',...version}}}
  assert.deepEqual(phoneChange(table,'league','30'),{refresh:true,version:'31'})
  assert.deepEqual(phoneChange(table,'league','31'),{refresh:false,version:'31'})
  for(const topic of ['lineup','roster','score','game','stat','player_stats','inventory','resources'])assert.equal(phoneChange(batch({topic}),'league').refresh,true)
})

test('foreign, deleted and invalid hints do not refresh a screen',()=>{
  assert.equal(phoneChange(batch({league_id:'foreign',...version}),'league').refresh,false)
  assert.equal(phoneChange({payload:{hints:[{event:'DELETE',row:version}]}},'league').refresh,false)
  assert.equal(phoneChange(batch({topic:'version',details:[{...version.details[0],version:'invalid'}]}),'league').refresh,false)
  assert.equal(phoneChange({payload:{league_id:'league',topic:'score'}},'league').refresh,false)
  assert.equal(phoneChange({payload:{schema:'private',table:'league_change_hints',eventType:'UPDATE',new:{league_id:'league',...version}}},'league').refresh,false)
})

test('phone and application policies skip unrelated versions and future lineups',()=>{
  const selection={seasonId:'season',memberIds:['mine','opponent'],date:'2026-11-01'}
  const row={topic:'version',details:[{version:'31',topic:'roster',created_at:'2026-11-01T00:00:00Z',
    scope:{topics:['roster'],hints:[{topic:'roster',scopes:[{season_id:'season',member_id:'other'}]}]}}]}
  assert.deepEqual(phoneChange(batch(row),'league','30',selection),{refresh:false,version:'31'})
  assert.deepEqual(phoneChange(batch(row),'league','29',selection),{refresh:true,recover:true,version:'31'})
  assert.equal(phoneChange(batch({topic:'lineup',scopes:[{season_id:'season',date:'2026-11-02'}]}),'league','30',selection).refresh,false)
  assert.equal(phoneChange(batch({topic:'score',scopes:[{season_id:'season'}]}),'league','30',selection).refresh,true)
})


test('phones request a forecast patch only for an unbroken forecast-only version',()=>{
  const row={topic:'version',details:[{version:'31',topic:'forecast',created_at:'2026-11-01T00:00:00Z',
    scope:{topics:['forecast'],tables:['matchup_forecasts'],forecastMatchupIds:['matchup']}}]}
  assert.deepEqual(phoneChange(batch(row),'league','30',{matchupId:'matchup'}),{refresh:true,forecastOnly:true,version:'31'})
  assert.deepEqual(phoneChange(batch(row),'league','29',{matchupId:'matchup'}),{refresh:true,recover:true,version:'31'})
  row.details[0].scope.topics.push('score')
  assert.deepEqual(phoneChange(batch(row),'league','30',{matchupId:'matchup'}),{refresh:true,version:'31'})
})


test('official score changes use a scoped score read and mixed changes keep a full read',()=>{
  const row={topic:'version',details:[{version:'31',topic:'game',created_at:'2026-11-01T00:00:00Z',
    scope:{topics:['game','stat'],tables:['nba_games','player_game_stats']}}]}
  assert.deepEqual(phoneChange(batch(row),'league','30'),{refresh:true,scoreOnly:true,version:'31'})
  row.details[0].scope.topics.push('lineup')
  assert.deepEqual(phoneChange(batch(row),'league','30'),{refresh:true,version:'31'})
})


test('unrelated averages can advance the stream while a score read is in flight',()=>{
  const row={topic:'version',details:[{version:'32',topic:'score',created_at:'2026-11-01T00:00:00Z',
    scope:{topics:['score'],tables:['matchups'],hints:[{topic:'score',details:[{resource:'averages'}]}]}}]}
  assert.deepEqual(phoneChange(batch(row),'league','31'),{refresh:false,version:'32'})
})

test('earlier-week corrections refresh a displayed multi-week total',()=>{
  const row={topic:'version',details:[{version:'31',topic:'score',created_at:'2026-11-01T00:00:00Z',
    scope:{topics:['score'],tables:['matchups'],hints:[{topic:'score',scopes:[{season_id:'season',week:1}]}]}}]}
  assert.deepEqual(phoneChange(batch(row),'league','30',{seasonId:'season',week:2,roundStartWeek:1,roundEndWeek:2}),{refresh:true,scoreOnly:true,version:'31'})
})


test('complete recovered versions avoid Home reads for unrelated changes',()=>{
  const hints=['31','32'].map(version=>({event:'UPDATE',row:{topic:'version',details:[{version,topic:'score',created_at:'2026-11-01T00:00:00Z',scope:{homeChanged:false}}]}}))
  assert.deepEqual(phoneChange({payload:{hints}},'league','30'),{refresh:false,version:'32'})
  hints[0].row.details[0].scope={topics:['roster']}
  assert.deepEqual(phoneChange({payload:{hints}},'league','30'),{refresh:true,version:'32'})
  assert.deepEqual(phoneChange({payload:{hints:hints.slice(1)}},'league','30'),{refresh:true,recover:true,version:'32'})
})
