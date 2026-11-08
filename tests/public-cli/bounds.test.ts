import { expect, it } from 'vitest'
import { createPublicHandler, publicContract, resourceNames } from '../../supabase/functions/api/public/handler'
import { publicValue, type Shape } from '../../supabase/functions/api/public/policy'

const league='11111111-1111-4111-8111-111111111111'
function sample(shape: Shape): unknown {
  if (shape.const !== undefined) return shape.const
  if (shape.enum) return shape.enum[0]
  if (shape.properties) return Object.fromEntries(Object.entries(shape.properties).map(([key,value])=>[key,sample(value)]))
  if (shape.items) return []
  const type=Array.isArray(shape.type)?shape.type[0]:shape.type
  return type==='string'?league.slice(0,shape.maxLength ?? 1024):type==='boolean'?false:1
}

it('keeps an accepted long league and its neighbours readable',async()=>{
  const name='A'.repeat(1025)
  const handler=createPublicHandler(async()=>({status:200,items:[{id:league,name,status:'active'},{id:league,name:'Neighbour',status:'active'}],hasMore:false}),()=>true)
  const response=(await handler(new Request('http://localhost/public/v2/leagues'),'/public/v2/leagues'))!
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.items.map((item:{name:string})=>item.name)).toEqual([name.slice(0,1024),'Neighbour'])
})

it('uses Unicode code points for public text limits',()=>{
  const shape=publicContract.resources.leagues.properties.items.items.properties.name
  expect(publicValue('😀'.repeat(1025),shape)).toBe('😀'.repeat(1024))
})

it.each(resourceNames)('bounds every public string in %s without losing the record',async resource=>{
  const fill=(shape:Shape):unknown=>{
    if(shape['x-overflow']==='truncate' && (Array.isArray(shape.type)?shape.type:[shape.type]).includes('string'))return '😀'.repeat((shape.maxLength ?? 1024)+1)
    if(shape.properties)return Object.fromEntries(Object.entries(shape.properties).map(([key,value])=>[key,fill(value)]))
    if(shape.items)return Array.from({length:(shape.maxItems ?? 50)+1},()=>fill(shape.items!))
    return sample(shape)
  }
  const shape=publicContract.resources[resource].properties.items.items
  const row=fill(shape) as Record<string,unknown>
  const handler=createPublicHandler(async()=>({status:200,items:[row],hasMore:false}),()=>true)
  const query=resource==='leagues'?'':`league=${league}${resource==='rosters'?`&team=${league}`:''}`
  const response=(await handler(new Request(`http://localhost/public/v2/${resource}?${query}`),`/public/v2/${resource}`))!
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.items).toEqual([publicValue(row,shape)])
  expect(body.items[0].id).toBe(row.id)
})

it('keeps every record reachable when bounded strings fill the wire budget',async()=>{
  const shape=publicContract.resources['player-stats'].properties.items.items
  const base=sample(shape) as Record<string,unknown>
  for(const name of ['name','nbaId','nbaTeam','injuryStatus','status','injuryReason','headshotUrl'])base[name]='\u0000'.repeat(1024)
  const rows=Array.from({length:100},(_,index)=>({...base,id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,leagueId:league}))
  const handler=createPublicHandler(async(_league,_resource,params)=>({status:200,items:rows.slice(Number(params.offset),Number(params.offset)+Number(params.limit)),hasMore:Number(params.offset)+Number(params.limit)<rows.length}),()=>true)
  let cursor:string|null=null
  const ids:string[]=[]
  for(let page=0;page<10;page++){
    const url=`http://localhost/public/v2/player-stats?league=${league}&limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`
    const response=(await handler(new Request(url),'/public/v2/player-stats'))!
    expect(response.status).toBe(200)
    const text=await response.text()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2*1024*1024)
    const body=JSON.parse(text)
    ids.push(...body.items.map((item:{id:string})=>item.id))
    cursor=body.nextCursor
    if(!cursor)break
  }
  expect(ids).toEqual(rows.map(row=>row.id))
})
