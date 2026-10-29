import assert from 'node:assert/strict'
import test from 'node:test'
import { rankingPage } from './database-rankings.mjs'

const rows=Array.from({length:300},(_,index)=>({source:'hashtagbasketball.com',source_rank:index+1,source_player_name:'A < B & C',source_player_id:null,source_positions:['PG'],source_team:'BOS',age:22,rank_change:-2,points:12.5,comment:'Stored <text>'}))
test('stored rankings retain values and escape source text',()=>{
  const page=rankingPage(rows)
  assert.match(page,/A &lt; B &amp; C/)
  assert.match(page,/Stored &lt;text&gt;/)
  assert.match(page,/>12.5<span class="lbl">PTS/)
  assert.match(page,/arrow-circle-down/)
  assert.equal((page.match(/<span>#/g)??[]).length,300)
})
test('incomplete, duplicate and unrecorded ranking views fail closed',()=>{
  assert.throws(()=>rankingPage(rows.slice(1)),/complete ranking/)
  assert.throws(()=>rankingPage([...rows,rows[0]]),/Duplicate/)
  assert.throws(()=>rankingPage(rows,new URLSearchParams({'ctl00$ContentPlaceHolder1$DDTYPE':'UNKNOWN'})),/Unknown/)
  assert.throws(()=>rankingPage(rows,new URLSearchParams({'ctl00$ContentPlaceHolder1$DDTYPE':'ROOKIE'})),/complete ranking/)
})
