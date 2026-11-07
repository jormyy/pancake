import { createPublicReader } from './reader.ts'
import { createPublicHandler } from './handler.ts'

function assert(value: unknown, message='Assertion failed'): asserts value { if (!value) throw new Error(message) }

Deno.test('public admission resolves before the separate read RPC starts',async()=>{
  const events:string[]=[]
  const reader=createPublicReader({async rpc(name){
    if(name==='public_admit_read'){
      events.push('admission transaction starts')
      await Promise.resolve()
      events.push('admission transaction commits')
      return {data:{status:200},error:null}
    }
    events.push('read transaction starts')
    return {data:{status:200,items:[],hasMore:false},error:null}
  }})
  await reader(null,'leagues',{limit:25},'a'.repeat(64))
  assert(events.join('|')==='admission transaction starts|admission transaction commits|read transaction starts')
})

Deno.test('a slow read does not hold admission for another client',async()=>{
  let release:()=>void=()=>{}
  const waiting=new Promise<void>(resolve=>{release=resolve})
  let firstRead=false
  let firstStarted:()=>void=()=>{}
  const started=new Promise<void>(resolve=>{firstStarted=resolve})
  const reader=createPublicReader({async rpc(name,params){
    if(name==='public_admit_read')return {data:{status:200},error:null}
    if(params.p_client_key==='a'.repeat(64)){
      firstRead=true
      firstStarted()
      await waiting
    }
    return {data:{status:200,items:[],hasMore:false},error:null}
  }})
  const first=reader(null,'leagues',{},'a'.repeat(64))
  await started
  assert(firstRead)
  const second=await reader(null,'leagues',{},'b'.repeat(64))
  assert(second.status===200)
  release()
  await first
})

Deno.test('denied admissions never start data reads',async()=>{
  const calls:string[]=[]
  const reader=createPublicReader({async rpc(name){calls.push(name);return {data:{status:429,retryAfter:60},error:null}}})
  const response=await reader(null,'leagues',{},'a'.repeat(64))
  assert(response.status===429&&calls.join(',')==='public_admit_read')
})

Deno.test('forwarded-header rotation cannot exhaust other clients',async()=>{
  const buckets=new Map<string,number>()
  const reader=createPublicReader({async rpc(name,params){
    if(name==='public_admit_read'){
      const key=String(params.p_client_key)
      const count=(buckets.get(key)??0)+1
      buckets.set(key,count)
      return {data:count>60?{status:429,retryAfter:60}:{status:200},error:null}
    }
    return {data:{status:200,items:[],hasMore:false},error:null}
  }})
  for(let i=0;i<650;i++){
    const handler=createPublicHandler(reader)
    const response=await handler(new Request('https://project.supabase.co/functions/v1/api/public/v2/leagues',{
      headers:{'cf-connecting-ip':'203.0.113.10','x-forwarded-for':`192.0.2.${i}`,'x-real-ip':`192.0.2.${i}`},
    }),'/public/v2/leagues')
    assert(response?.status===(i<60?200:429))
  }
  const originalCount=buckets.size
  assert(originalCount===1)
  const other=await createPublicHandler(reader)(new Request('https://project.supabase.co/functions/v1/api/public/v2/leagues',{
    headers:{'cf-connecting-ip':'203.0.113.11'},
  }),'/public/v2/leagues')
  assert(other?.status===200&&buckets.size===2)
})

Deno.test('missing or malformed trusted headers share one anonymous bucket',async()=>{
  const keys:string[]=[]
  const reader=createPublicReader({async rpc(name,params){
    if(name==='public_admit_read')keys.push(String(params.p_client_key))
    return {data:{status:200,items:[],hasMore:false},error:null}
  }})
  const cases:Record<string,string>[]=[{},{'x-forwarded-for':'192.0.2.9'},{'cf-connecting-ip':'192.0.2.9, 192.0.2.10'}]
  for(const headers of cases){
    await createPublicHandler(reader)(new Request('http://localhost/public/v2/leagues',{headers}),'/public/v2/leagues')
  }
  assert(new Set(keys).size===1)
})

Deno.test('RPC errors cannot disclose database exception text',async()=>{
  for(const failing of ['public_admit_read','public_read_v2']){
    const reader=createPublicReader({async rpc(name){return {data:{status:200,items:[],hasMore:false},error:name===failing?{message:'SQL PRIVATE_SENTINEL select auth.users'}:null}}})
    const response=(await createPublicHandler(reader)(new Request('http://localhost/public/v2/leagues'),'/public/v2/leagues'))!
    assert(response.status===503)
    assert(!(await response.text()).includes('PRIVATE_SENTINEL'))
  }
})
