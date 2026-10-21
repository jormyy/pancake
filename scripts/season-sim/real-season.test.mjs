import assert from 'node:assert/strict'
import test from 'node:test'
import {checkRealCoverage,realSeasonDay} from './real-season.mjs'

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
