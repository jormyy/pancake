import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPublicHandler, publicContract, resourceNames } from '../../supabase/functions/api/public/handler'
import { modelObservation, type Shape } from '../../supabase/functions/api/public/policy'

const league = '11111111-1111-4111-8111-111111111111'
function sample(shape: Shape): unknown {
  if (shape.const !== undefined) return shape.const
  if (shape.enum) return shape.enum[0]
  if (shape.properties) return Object.fromEntries(Object.entries(shape.properties).map(([key,value])=>[key,sample(value)]))
  if (shape.items) return []
  const type=Array.isArray(shape.type)?shape.type[0]:shape.type
  return type==='string'?league.slice(0,shape.maxLength ?? 1024):type==='boolean'?false:1
}
describe('public v2 projection',()=>{
  it.each(resourceNames)('%s is independent of random private fields',async resource=>{
    const raw=sample(publicContract.resources[resource].properties.items.items) as Record<string,unknown>
    const handler=createPublicHandler(async()=>({status:200,items:[raw],hasMore:false}),()=>true)
    const url=`http://localhost/public/v2/${resource}?${resource==='leagues'?'':`league=${league}`}${resource==='rosters'?`&team=${league}`:''}`
    const expected=await (await handler(new Request(url),`/public/v2/${resource}`))!.text()
    let seed=73491
    for(let i=0;i<50;i++){
      seed=(seed*1664525+1013904223)>>>0
      Object.assign(raw,{[`private_${seed}`]:{email:`secret-${seed}`,claims:[seed],bid:seed,notes:'private'}})
      expect(await (await handler(new Request(url),`/public/v2/${resource}`))!.text()).toBe(expected)
    }
  })
  it('filters nonexecuted trades before search, order, counts and pagination',()=>{
    const shape=publicContract.resources.trades.properties.items.items
    const completed={...sample(shape) as Record<string,unknown>,id:'visible',leagueId:league,status:'completed',completedAt:'2026-01-01'}
    const hidden=['pending','accepted','rejected','expired','vetoed'].map(status=>({...completed,id:'hidden',status}))
    for(const params of [{limit:1},{query:'hidden'},{sort:'id',direction:'desc'},{limit:1,offset:1}]) {
      expect(modelObservation('trades',[...hidden,completed],{league,...params})).toEqual(modelObservation('trades',[completed],{league,...params}))
    }
  })
  it('keeps generated contracts identical',()=>{
    expect(JSON.parse(readFileSync('packages/pancake-cli/schemas/v2.json','utf8'))).toEqual(publicContract)
  })
  it('makes cursor scopes depend on the league and filters',async()=>{
    const handler=createPublicHandler(async()=>({status:200,items:[],hasMore:true}))
    const call=(leagueId:string,extra='')=>handler(new Request(`http://localhost/public/v2/teams?league=${leagueId}${extra}`),'/public/v2/teams')
    const cursor=(await (await call(league))!.json()).nextCursor
    expect((await call(league,`&cursor=${encodeURIComponent(cursor)}`))?.status).toBe(200)
    expect((await call('22222222-2222-4222-8222-222222222222',`&cursor=${encodeURIComponent(cursor)}`))?.status).toBe(400)
  })
})
it('free-agent pages and cursors are independent of private pending claims and bids',async()=>{
  const shape=publicContract.resources['free-agents'].properties.items.items
  const base={...sample(shape) as Record<string,unknown>,leagueId:league,id:league,name:'Ada',availability:'free-agent',waiverClearsAt:null,waiverEligible:true}
  const second={...base,id:'22222222-2222-4222-8222-222222222222',name:'Zed',availability:'waivers',waiverClearsAt:'2026-12-01'}
  let secret:Record<string,unknown>={}
  const handler=createPublicHandler(async(_league,resource,params)=>modelObservation(resource,[{...base,...secret},{...second,...secret}],{league,...params}),()=>true)
  const url=`http://localhost/public/v2/free-agents?league=${league}&limit=1&sort=name`
  const first=await (await handler(new Request(url),'/public/v2/free-agents'))!.text()
  const cursor=JSON.parse(first).nextCursor
  const next=`${url}&cursor=${encodeURIComponent(cursor)}`
  const secondPage=await (await handler(new Request(next),'/public/v2/free-agents'))!.text()
  for(let count=0;count<20;count++){
    secret={claimed:true,pendingClaims:Array.from({length:count},(_,claimOrder)=>({playerId:league,bidAmount:count*239,claimOrder,status:'pending'})),claimCount:count,bidAmount:count*999}
    expect(await (await handler(new Request(url),'/public/v2/free-agents'))!.text()).toBe(first)
    expect(await (await handler(new Request(next),'/public/v2/free-agents'))!.text()).toBe(secondPage)
  }
  expect(first).toContain('free-agent')
  expect(secondPage).toContain('waivers')
  expect(first+secondPage).not.toContain('pending')
})
