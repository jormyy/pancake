import { createLimiter, createPublicHandler, publicContract, resourceNames, type PublicRead } from './handler.ts'
import type { Shape } from './policy.ts'
import { cell, columns } from './web.ts'

const league = '11111111-1111-4111-8111-111111111111'
function assert(value: unknown, message = 'Assertion failed'): asserts value { if (!value) throw new Error(message) }
function sample(shape: Shape): unknown {
  if (shape.const !== undefined) return shape.const
  if (shape.enum) return shape.enum[0]
  if (shape.properties) return Object.fromEntries(Object.entries(shape.properties).map(([key,value]) => [key,sample(value)]))
  if (shape.items) return []
  const type = Array.isArray(shape.type) ? shape.type[0] : shape.type
  return type === 'string' ? league.slice(0,shape.maxLength ?? 1024) : type === 'boolean' ? false : 1
}
const source=(read: PublicRead)=>({admit:async()=>({status:200}),read})
function request(resource: string, extra = '', headers: Record<string,string> = {}) {
  return new Request(`http://localhost/public/v2/${resource}?${resource === 'leagues' ? '' : `league=${league}`}${resource === 'rosters' ? `&team=${league}` : ''}${extra}`,{headers})
}
for (const resource of resourceNames) Deno.test(`public v2 ${resource} omits private fields without login`,async () => {
  const item = sample(publicContract.resources[resource].properties.items.items) as Record<string,unknown>
  const handler = createPublicHandler(source(async () => ({status:200,items:[{...item,notes:'SECRET',email:'SECRET',bid_amount:99}],hasMore:false})))
  const response = (await handler(request(resource),`/public/v2/${resource}`))!
  assert(response.status===200)
  const text = await response.text()
  assert(!text.includes('SECRET')&&!text.includes('bid_amount'))
})
Deno.test('public v2 rejects missing or malformed IDs before calling SQL',async () => {
  let calls=0
  const handler=createPublicHandler(source(async()=>{calls++;throw new Error('SQL must not run')}))
  const queries=['','?league=bad',`?league=${league}&team=bad`]
  const responses=[]
  for(const query of queries){
    const response=(await handler(new Request(`http://localhost/public/v2/teams${query}`),'/public/v2/teams'))!
    assert(response.status===400)
    responses.push(await response.text())
  }
  for(const [resource,key] of [['players','player'],['drafts','draft'],['trades','trade']]) {
    const response=(await handler(new Request(`http://localhost/public/v2/${resource}?league=${league}&${key}=bad`),`/public/v2/${resource}`))!
    assert(response.status===400)
    responses.push(await response.text())
  }
  assert(new Set(responses).size===1&&calls===0)
})
Deno.test('public v2 verifies database errors and revokes old API',async () => {
  const handler = createPublicHandler(source(async () => { throw new Error('SECRET') }))
  assert((await handler(request('league'),'/public/v1/league'))?.status===410)
  const response = (await handler(request('league'),'/public/v2/league'))!
  assert(response.status===503&&!((await response.text()).includes('SECRET')))
})
Deno.test('public v2 limiter is bounded and resets each minute',() => {
  let now=0
  const limiter=createLimiter(()=>now)
  for (let i=0;i<240;i++) assert(limiter('same')===0)
  now=45500
  assert(limiter('same')===15)
  now=60000
  assert(limiter('same')===0)
  for(let i=0;i<1000;i++) assert(limiter(`client-${i}`)===0)
  assert(limiter('another-client')===0)
})
Deno.test('public v2 validates fields and preserves conditional reads',async () => {
  const item=sample(publicContract.resources.league.properties.items.items)
  const handler=createPublicHandler(source(async()=>({status:200,items:[item],hasMore:false})))
  for (const query of ['&limit=51','&limit=0','&sort=private','&query=bad','&direction=sideways','&cursor=bad']) assert((await handler(request('league',query),'/public/v2/league'))?.status===400)
  const first=(await handler(request('league'),'/public/v2/league'))!
  assert(first.status===200)
  assert((await handler(request('league','',{'if-none-match':first.headers.get('etag')!}),'/public/v2/league'))?.status===304)
  assert((await handler(new Request(request('league'),{method:'POST'}),'/public/v2/league'))?.status===405)
})
Deno.test('public v2 private trade states fail closed',async()=>{
  const item=sample(publicContract.resources.trades.properties.items.items) as Record<string,unknown>
  for(const status of ['pending','accepted','vetoed','rejected','expired']){
    const handler=createPublicHandler(source(async()=>({status:200,items:[{...item,status}],hasMore:false})))
    assert((await handler(request('trades'),'/public/v2/trades'))?.status===503)
  }
})
Deno.test('public v2 bounds response size and relays durable rate limits',async()=>{
  const item=sample(publicContract.resources.teams.properties.items.items) as Record<string,unknown>
  const tooLong=createPublicHandler(source(async()=>({status:200,items:[{id:league,name:'x'.repeat(1025),status:'active'}],hasMore:false})))
  assert((await tooLong(request('leagues'),'/public/v2/leagues'))?.status===200)
  const tooMany=createPublicHandler(source(async()=>({status:200,items:Array(51).fill(item),hasMore:false})))
  assert((await tooMany(request('teams'),'/public/v2/teams'))?.status===503)
  const rate=createPublicHandler(source(async()=>({status:429,retryAfter:900})))
  const response=(await rate(request('teams'),'/public/v2/teams'))!
  assert(response.status===429&&response.headers.get('retry-after')==='60')
})
Deno.test('public v2 does not serialize another league',async()=>{
  const item=sample(publicContract.resources.teams.properties.items.items) as Record<string,unknown>
  const handler=createPublicHandler(source(async()=>({status:200,items:[{...item,leagueId:'other'}],hasMore:false})))
  const response=(await handler(request('teams'),'/public/v2/teams'))!
  assert(response.status===503&&!((await response.text()).includes('other')))
})
Deno.test('public v2 sends the league scope and bounded filters to the reader',async()=>{
  let seen=false
  const handler=createPublicHandler(source(async(scope,resource,params,clientKey)=>{
    assert(scope===league&&resource==='teams')
    assert(params.limit===2&&params.team===league&&params.offset===0)
    assert(/^[a-f0-9]{64}$/.test(clientKey))
    seen=true
    return {status:200,items:[],hasMore:false}
  }))
  assert((await handler(request('teams',`&limit=2&team=${league}`),'/public/v2/teams'))?.status===200)
  assert(seen)
})
function webSource(items: (resource: string) => Record<string,unknown>[], admissions: string[] = []) {
  const leagueRow={...sample(publicContract.resources.league.properties.items.items) as Record<string,unknown>,id:league,leagueId:league,name:'Synthetic League',seasonYear:2026}
  return {
    admit: async (key: string) => { admissions.push(key); return {status:200} },
    read: (async (_scope, resource, params) => {
      const rows=resource==='league'?[leagueRow]:items(resource)
      const offset=Number(params.offset),limit=Number(params.limit)
      return {status:200,items:rows.slice(offset,offset+limit),hasMore:rows.length>offset+limit}
    }) as PublicRead,
  }
}
function table(text: string) {
  const lines=text.split('\n'),start=lines.findIndex(line=>line.startsWith('| ')&&lines[lines.indexOf(line)+1]?.startsWith('| ---'))
  if(start<0)return {header:[],rows:[]}
  const split=(line:string)=>line.slice(2,-2).split(/(?<!\\)\| /).map(part=>part.trim())
  const rows=[]
  for(let i=start+2;i<lines.length&&lines[i].startsWith('| ');i++)rows.push(split(lines[i]))
  return {header:split(lines[start]),rows}
}
for (const resource of resourceNames) Deno.test(`public web ${resource} shows the JSON records without private fields`,async () => {
  const item={...sample(publicContract.resources[resource].properties.items.items) as Record<string,unknown>,leagueId:league,name:'Pipe | Name'}
  const handler=createPublicHandler(webSource(()=>[{...item,notes:'SECRET',email:'SECRET'},{...item,id:'second',notes:'SECRET'}]))
  const json=await (await handler(request(resource,'&limit=1'),`/public/v2/${resource}`))!.json()
  const response=(await handler(new Request(request(resource,'&limit=1').url.replace('/v2/','/web/')),`/public/web/${resource}`))!
  assert(response.status===200&&response.headers.get('content-type')==='text/markdown; charset=utf-8')
  const text=await response.text()
  assert(!text.includes('SECRET'))
  const {header,rows}=table(text)
  assert(JSON.stringify(header.slice(0,columns(resource).length))===JSON.stringify(columns(resource)))
  assert(rows.length===json.items.length)
  json.items.forEach((record: Record<string,unknown>,index: number)=>assert(JSON.stringify(rows[index].slice(0,columns(resource).length))===JSON.stringify(columns(resource).map(field=>cell(record[field]))),`${resource} row ${index}`))
  assert(json.nextCursor===null?text.includes('This is the last page.'):text.includes(`cursor=${encodeURIComponent(json.nextCursor)}`))
  if(resource!=='leagues')assert(text.includes('Synthetic League')&&text.includes('Season: 2026'))
  assert(/Freshness: read live from the Pancake database at \d{4}-\d\d-\d\dT/.test(text))
})
Deno.test('public web league search lists every match and says when none match',async()=>{
  const names=['Official League','Official League Two','Dynasty Club']
  const handler=createPublicHandler(webSource(()=>names.map((name,index)=>({id:`${index}1111111-1111-4111-8111-111111111111`,name,status:'active'}))))
  const page=async(query:string)=>(await handler(new Request(`http://localhost/public/web/leagues${query}`),'/public/web/leagues'))!.text()
  assert((await page('')).includes('Public leagues on this page: 3.'))
  assert((await page('?query=official')).includes('3 public league names contain "official". The name is ambiguous'))
  assert((await page('?query=official&limit=2')).includes('2 or more public league names contain "official"'))
  const exact=await page('?query=official%20league')
  assert(exact.includes('Exact name match: Official League. Open its league home: http://localhost/functions/v1/api/public/web/league?league=01111111-1111-4111-8111-111111111111')&&exact.includes('2 other public league names also contain "official league"'))
  const one=createPublicHandler(webSource(()=>[{id:league,name:'Official League',status:'active'}]))
  const single=await (await one(new Request('http://localhost/public/web/leagues?query=Official%20League'),'/public/web/leagues'))!.text()
  assert(single.includes(`One public league name contains "Official League": Official League. Open its league home: http://localhost/functions/v1/api/public/web/league?league=${league}`))
  const none=createPublicHandler(webSource(()=>[]))
  assert((await (await none(new Request('http://localhost/public/web/leagues?query=missing'),'/public/web/leagues'))!.text()).includes('No public league name contains "missing".'))
  const start=await (await none(new Request('http://localhost/public/web'),'/public/web'))!.text()
  assert(start.startsWith('# Pancake public league data')&&start.includes('/public/web/leagues?query=NAME'))
})
Deno.test('public web pages admit one read and fail as plain text',async()=>{
  const admissions:string[]=[]
  const handler=createPublicHandler(webSource(()=>[],admissions))
  assert((await handler(new Request(`http://localhost/public/web/league?league=${league}`),'/public/web/league'))?.status===200)
  assert(admissions.length===1)
  for(const [path,status] of [[`/public/web/teams`,400],[`/public/web/teams?league=${league}&bid=1`,400],[`/public/web/claims?league=${league}`,404]] as const){
    const response=(await handler(new Request(`http://localhost${path}`),path.split('?')[0]))!
    assert(response.status===status&&response.headers.get('content-type')==='text/markdown; charset=utf-8')
  }
  const limited=createPublicHandler({admit:async()=>({status:429,retryAfter:12}),read:async()=>{throw new Error('must not read')}})
  const response=(await limited(new Request('http://localhost/public/web'),'/public/web'))!
  assert(response.status===429&&response.headers.get('retry-after')==='12'&&(await response.text()).includes('240 public reads a minute'))
})
