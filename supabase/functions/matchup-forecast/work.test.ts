import assert from 'node:assert/strict'
import {runForecastWork} from './work.ts'
import type {ForecastClaim,ForecastWrite} from './work.ts'
import type {ForecastContext} from './compute.ts'
const claims:ForecastClaim[]=['one','two','bad'].map(matchup_id=>({matchup_id,revision:1,claim_token:'token'}))
const context=(matchupId:string):ForecastContext=>({matchupId,observedAt:'2026-11-01T12:00:00Z',today:'2026-11-01',weekEnd:'2026-11-01',isFinalized:true,
  teams:[{memberId:'home',currentPoints:100},{memberId:'away',currentPoints:90}],roster:[],games:[],history:[],projections:[],lineups:[],templates:[],automaticMembers:[],previous:null})
Deno.test('healthy forecasts publish in one transaction when another context fails',async()=>{
  const groups:ForecastWrite[][]=[],released:string[]=[]
  const result=await runForecastWork({claim:async()=>claims,context:async id=>{if(id==='bad')throw new Error('missing');return context(id)},
    publish:async items=>{groups.push(items);return items.map(item=>({matchupId:item.matchup_id,saved:true}))},
    fail:async claim=>{released.push(claim.matchup_id)}})
  assert.equal(groups.length,1);assert.equal(groups[0].length,2);assert.equal(result.completed,2);assert.deepEqual(released,['bad'])
})
Deno.test('failed receipts release only their own claim and missing receipts fail the group',async()=>{
  const released:string[]=[]
  const deps={claim:async()=>claims.slice(0,2),context:async(id:string)=>context(id),fail:async(claim:ForecastClaim)=>{released.push(claim.matchup_id)}}
  const result=await runForecastWork({...deps,publish:async()=>[{matchupId:'one',saved:false,error:'invalid'},{matchupId:'two',saved:true}]})
  assert.equal(result.completed,1);assert.deepEqual(released,['one'])
  released.length=0
  const missing=await runForecastWork({...deps,publish:async()=>[]})
  assert.equal(missing.completed,0);assert.deepEqual(released,['one','two'])
})
