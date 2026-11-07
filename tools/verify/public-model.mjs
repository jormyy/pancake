import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { modelObservation, publicContract, resourceNames, policy } from '../../supabase/functions/api/public/policy.ts'

const league = '11111111-1111-4111-8111-111111111111'
function sample(shape) {
  if (shape.const !== undefined) return shape.const
  if (shape.enum) return shape.enum[0]
  if (shape.properties) return Object.fromEntries(Object.entries(shape.properties).map(([key,value])=>[key,sample(value)]))
  if (shape.items) return []
  const type = Array.isArray(shape.type) ? shape.type[0] : shape.type
  return type==='string' ? 'public' : type==='boolean' ? false : 1
}
export function checkModel() {
  let checks = 0
  for (const resource of Object.values(policy.resources)) {
    assert.doesNotMatch(resource.source+' '+resource.where+' '+Object.values(resource.fields).map(field=>field.sql).join(' '),/\b(?:profiles|waiver_claims|bids|weekly_lineups|notifications)\b|auth\.users|auth\.uid/)
    for (const key of Object.keys(resource.fields)) assert.doesNotMatch(key,/^(?:email|userId|user_id|invite_code|bid_amount|notes|claims|messages|notificationSettings)$/)
  }
  const states = ['pending','accepted','rejected','withdrawn','countered','edited','expired','vetoed','completed']
  for (const resource of resourceNames) {
    const shape = publicContract.resources[resource].properties.items.items
    const publicRow = { ...sample(shape), id:'public', leagueId:league, deletedAt:null, isMock:false, isVoided:false,
      status:resource==='trades'||resource==='trade-assets'?'completed':sample(shape).status,
      completedAt:'2026-01-01', draftStatus:'completed', relatedTradeStatus:'completed', relatedTradeCompletedAt:'2026-01-01' }
    if (resource==='free-agents') {
      for (const availability of ['free-agent','waivers']) for (const bidAmount of [0,1,1000000]) for (const count of [0,1,8]) {
        const row={...publicRow,availability,waiverEligible:true,waiverClearsAt:availability==='waivers'?'2026-01-02':null}
        const claims=Array.from({length:count},(_,claimOrder)=>({playerId:row.id,status:'pending',bidAmount,claimOrder}))
        for (const request of [{league,limit:1},{league,query:'public'},{league,sort:'name',direction:'desc'},{league,offset:1,limit:1}]) {
          assert.deepEqual(modelObservation(resource,[{...row,pendingClaims:claims,claimCount:count,claimed:count>0,bidAmount}],request),modelObservation(resource,[row],request))
          checks++
        }
      }
    }
    const privateRows = []
    for (const state of states) for (const completedAt of [null,'2026-01-01']) {
      if (state==='completed' && completedAt!==null) continue
      if (resource==='trades'||resource==='trade-assets') privateRows.push({...publicRow,id:`private-${state}`,status:state,completedAt})
      if (resource==='transactions') privateRows.push({...publicRow,id:`private-${state}`,type:'trade_completed',relatedTradeStatus:state,relatedTradeCompletedAt:completedAt})
    }
    if (resource==='leagues') privateRows.push({...publicRow,id:'private-deleted',deletedAt:'2026-01-01'})
    if (['drafts','draft-results'].includes(resource)) privateRows.push({...publicRow,id:'private-mock',isMock:true})
    if (resource==='draft-results') privateRows.push({...publicRow,id:'private-open',draftStatus:'pending'})
    if (['matchups','scores','schedule'].includes(resource)) privateRows.push({...publicRow,id:'private-voided',isVoided:true})
    privateRows.push({...publicRow,id:'private-foreign',leagueId:'other'})
    const options = [{},{query:'private'},{sort:'id',direction:'desc'},{limit:1},{limit:1,offset:1},{limit:1,offset:2},...(resource==='trades'||resource==='trade-assets'?[{trade:'private-id'},{trade:'missing-id'}]:[])]
    for (const params of options) {
      const request = {league,...params}
      const expected = modelObservation(resource,[publicRow],request)
      for (const privateRow of privateRows) for (const order of [false,true]) {
        const records = order ? [privateRow,publicRow] : [publicRow,privateRow]
        assert.deepEqual(modelObservation(resource,records,request),expected,`${resource} private state changed observation`)
        checks++
      }
      for (let mask=0; mask<128; mask++) {
        const extra = ['claims','bid','message','account','commissioner','offer','negotiation'].filter((_,i)=>mask&(1<<i))
        const poison = Object.fromEntries(extra.map(key=>[key,{secret:'private',sortValue:-999,searchValue:'private'}]))
        assert.deepEqual(modelObservation(resource,[{...publicRow,...poison}],request),expected)
        checks++
      }
    }
  }
  return {checks,assumptions:[
    'SQL source tables and joins match the generated policy; live database execution is checked separately',
    'Public snapshots, clocks, and request/rate-limit histories are held fixed',
    'Private tables have no source edge into public projections',
    'No timing, resource-exhaustion, source-data correctness, or concurrent-update claim',
  ]}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(checkModel(),null,2))
