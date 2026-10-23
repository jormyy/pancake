import assert from 'node:assert/strict'
import test from 'node:test'
import {checkRealCoverage,realSeasonDay} from './real-season.mjs'

test('a bounded season checks only its dates and raw rookie appearances', () => {
  const profile = { start: '2025-10-21', end: '2025-11-10', prefix: '00225', games: 3, playoffStart: 25, calendar: { weeks: [{ week_number: 1, week_end: '2025-10-26' }, { week_number: 2, week_end: '2025-11-02' }, { week_number: 3, week_end: '2025-11-09' }, { week_number: 4, week_end: '2025-11-16' }] } }
  const games = [{ id: '0022500001', date: '2025-10-21' }, { id: '0022500002', date: '2025-11-09' }, { id: '0022500003', date: '2025-11-10' }]
  const days = Array.from({ length: 20 }, (_, index) => ({ date: new Date(Date.parse('2025-10-21T12:00:00Z') + index * 86400000).toISOString().slice(0, 10), finals: { games: index === 0 || index === 19 ? 1 : 0 } }))
  const rookies = [{ nbaId: '1', name: 'Rookie', gameIds: games.map(row => row.id) }]
  const observations = games.slice(0, 2).map(row => ({ nbaId: '1', gameId: row.id, started: true, points: 12 }))
  const options = { through: '2025-11-09', games }
  assert.equal(checkRealCoverage(profile, days, [2, 3], rookies, observations, options).gameRows, 2)
  assert.throws(() => checkRealCoverage(profile, days.slice(0, -1), [2, 3], rookies, observations, options))
  assert.throws(() => checkRealCoverage(profile, days, [2], rookies, observations, options))
  assert.throws(() => checkRealCoverage(profile, days, [2, 3], rookies, observations.slice(0, 1), options))
  assert.throws(() => checkRealCoverage(profile, days, [2, 3], rookies, [...observations, { nbaId: '1', gameId: games[2].id }], options))
})

test('real-season completion rejects missing dates, finals, weeks, and rookie appearances',()=>{
  const profile={start:'2025-10-21',end:'2025-10-21',games:1,playoffStart:3,calendar:{weeks:[{week_number:1},{week_number:2}]}}
  const days=[{date:profile.start,finals:{games:1}}],rookies=[{nbaId:'1',name:'Real Rookie',gameIds:['g']}],observations=[{nbaId:'1',gameId:'g',started:true,points:10}]
  assert.ok(checkRealCoverage(profile,days,[2],rookies,observations).passed)
  assert.throws(()=>checkRealCoverage(profile,[],[2],rookies,observations))
  assert.throws(()=>checkRealCoverage(profile,days,[],rookies,observations))
  assert.throws(()=>checkRealCoverage(profile,days,[2],rookies,[]))
  assert.throws(()=>checkRealCoverage(profile,[{...days[0],finals:{games:0}}],[2],rookies,observations))
})

test('idle Cup dates need no fantasy week but a regular game can never disappear in a gap',()=>{
  const profile={calendar:{weeks:[{week_start:'2024-12-19',week_end:'2024-12-22',week_number:9}]}}
  assert.equal(realSeasonDay(profile,'2024-12-17',[]),undefined)
  assert.throws(()=>realSeasonDay(profile,'2024-12-17',[{id:'0022400001'}]))
})
