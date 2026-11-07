import { createLimiter, createPublicHandler, publicContract, resourceNames } from './handler.ts'
import type { Shape } from './policy.ts'

const league = '11111111-1111-4111-8111-111111111111'
function assert(value: unknown, message = 'Assertion failed'): asserts value { if (!value) throw new Error(message) }
function sample(shape: Shape): unknown {
  if (shape.const !== undefined) return shape.const
  if (shape.enum) return shape.enum[0]
  if (shape.properties) return Object.fromEntries(Object.entries(shape.properties).map(([key,value]) => [key,sample(value)]))
  if (shape.items) return []
  const type = Array.isArray(shape.type) ? shape.type[0] : shape.type
  return type === 'string' ? league : type === 'boolean' ? false : 1
}
function request(resource: string, extra = '', headers: Record<string,string> = {}) {
  return new Request(`http://localhost/public/v2/${resource}?${resource === 'leagues' ? '' : `league=${league}`}${resource === 'rosters' ? `&team=${league}` : ''}${extra}`,{headers})
}
for (const resource of resourceNames) Deno.test(`public v2 ${resource} omits private fields without login`,async () => {
  const item = sample(publicContract.resources[resource].properties.items.items) as Record<string,unknown>
  const handler = createPublicHandler(async () => ({status:200,items:[{...item,notes:'SECRET',email:'SECRET',bid_amount:99}],hasMore:false}))
  const response = (await handler(request(resource),`/public/v2/${resource}`))!
  assert(response.status===200)
  const text = await response.text()
  assert(!text.includes('SECRET')&&!text.includes('bid_amount'))
})
Deno.test('public v2 malformed and missing league IDs share the same error',async () => {
  const handler = createPublicHandler(async () => ({status:404}))
  const replies = []
  for (const query of ['', '?league=bad',`?league=${league}`]) {
    const response = (await handler(new Request(`http://localhost/public/v2/league${query}`),'/public/v2/league'))!
    assert(response.status===404)
    replies.push(await response.text())
  }
  assert(new Set(replies).size===1)
})
Deno.test('public v2 verifies database errors and revokes old API',async () => {
  const handler = createPublicHandler(async () => { throw new Error('SECRET') })
  assert((await handler(request('league'),'/public/v1/league'))?.status===410)
  const response = (await handler(request('league'),'/public/v2/league'))!
  assert(response.status===503&&!((await response.text()).includes('SECRET')))
})
Deno.test('public v2 limiter is bounded and resets each minute',() => {
  let now=0
  const limiter=createLimiter(()=>now)
  for (let i=0;i<60;i++) assert(limiter('same'))
  assert(!limiter('same'))
  now=60000
  assert(limiter('same'))
  const global=createLimiter()
  for(let i=0;i<600;i++) assert(global(String(i)))
  assert(!global('new'))
})
Deno.test('public v2 validates fields and preserves conditional reads',async () => {
  const item=sample(publicContract.resources.league.properties.items.items)
  const handler=createPublicHandler(async()=>({status:200,items:[item],hasMore:false}))
  for (const query of ['&limit=51','&limit=0','&sort=private','&query=bad','&direction=sideways','&cursor=bad']) assert((await handler(request('league',query),'/public/v2/league'))?.status===400)
  const first=(await handler(request('league'),'/public/v2/league'))!
  assert(first.status===200)
  assert((await handler(request('league','',{'if-none-match':first.headers.get('etag')!}),'/public/v2/league'))?.status===304)
  assert((await handler(new Request(request('league'),{method:'POST'}),'/public/v2/league'))?.status===405)
})
Deno.test('public v2 private trade states fail closed',async()=>{
  const item=sample(publicContract.resources.trades.properties.items.items) as Record<string,unknown>
  for(const status of ['pending','accepted','vetoed','rejected','expired']){
    const handler=createPublicHandler(async()=>({status:200,items:[{...item,status}],hasMore:false}))
    assert((await handler(request('trades'),'/public/v2/trades'))?.status===503)
  }
})
Deno.test('public v2 bounds response size and relays durable rate limits',async()=>{
  const item=sample(publicContract.resources.teams.properties.items.items) as Record<string,unknown>
  const tooLong=createPublicHandler(async()=>({status:200,items:[{...item,name:'x'.repeat(1025)}],hasMore:false}))
  assert((await tooLong(request('teams'),'/public/v2/teams'))?.status===503)
  const tooMany=createPublicHandler(async()=>({status:200,items:Array(51).fill(item),hasMore:false}))
  assert((await tooMany(request('teams'),'/public/v2/teams'))?.status===503)
  const rate=createPublicHandler(async()=>({status:429,retryAfter:900}))
  const response=(await rate(request('teams'),'/public/v2/teams'))!
  assert(response.status===429&&response.headers.get('retry-after')==='60')
})
Deno.test('public v2 does not serialize another league',async()=>{
  const item=sample(publicContract.resources.teams.properties.items.items) as Record<string,unknown>
  const handler=createPublicHandler(async()=>({status:200,items:[{...item,leagueId:'other'}],hasMore:false}))
  const response=(await handler(request('teams'),'/public/v2/teams'))!
  assert(response.status===503&&!((await response.text()).includes('other')))
})
Deno.test('public v2 sends the league scope and bounded filters to the reader',async()=>{
  let seen=false
  const handler=createPublicHandler(async(scope,resource,params,clientKey)=>{
    assert(scope===league&&resource==='teams')
    assert(params.limit===2&&params.team===league&&params.offset===0)
    assert(/^[a-f0-9]{64}$/.test(clientKey))
    seen=true
    return {status:200,items:[],hasMore:false}
  })
  assert((await handler(request('teams',`&limit=2&team=${league}`),'/public/v2/teams'))?.status===200)
  assert(seen)
})
