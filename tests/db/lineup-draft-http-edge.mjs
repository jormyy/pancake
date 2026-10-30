const deno = globalThis.Deno
const input = JSON.parse(deno.env.get('ACTION_INPUT'))
const RealDate = Date
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [input.anchor])) }
  static now() { return RealDate.parse(input.anchor) }
}
let ticks = 0
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => ticks++ })
let identifiers = 0
Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: () => `88888888-8888-4888-8888-${String(++identifiers).padStart(12,'0')}` })
deno.env.set('SUPABASE_URL','http://127.0.0.1:64521')
deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN','lineup-draft-private')
deno.env.set('NBA_COM_BASE_URL','http://127.0.0.1:64590')
deno.env.set('NBA_STATS_BASE_URL','http://127.0.0.1:64590')
const handlers = {}
const serve = Object.getOwnPropertyDescriptor(deno,'serve')
for (const name of ['lineup-optimizer','close-expired-nominations','sync-draft-order']) {
  Object.defineProperty(deno,'serve',{ configurable:true,value:handler => { handlers[name]=handler } })
  await import(`../../supabase/functions/${name}/index.ts`)
}
Object.defineProperty(deno,'serve',serve)
const originalFetch = globalThis.fetch
const requests = []
let pending=Promise.resolve()
globalThis.fetch = async (resource,options) => {
  const request = new Request(resource,options)
  const url = new URL(request.url)
  if (url.hostname !== '127.0.0.1' || !url.port.startsWith('645')) throw new Error(`External request refused: ${url.origin}`)
  if (url.port==='64590') return Response.json({ error:'Use the injected NBA article' },{status:500})
  if (url.pathname.startsWith('/functions/v1/')) {
    const handler=handlers[url.pathname.split('/').at(-1)]
    if (!handler) throw new Error('Unexpected private function')
    return await handler(request)
  }
  const previous=pending
  let finish
  pending=new Promise(resolve=>{ finish=resolve })
  await previous
  let response
  try {
    response=await originalFetch(request)
    await response.clone().arrayBuffer()
  } finally { finish() }
  requests.push({ path:url.pathname,method:request.method,bytes:(await response.clone().arrayBuffer()).byteLength,status:response.status })
  if(response.status>=400) console.error('HTTP_FAILURE '+url.pathname+' '+await response.clone().text())
  return response
}
if (input.name==='sync-draft-order') {
  const forwarding=globalThis.fetch
  globalThis.fetch=async(resource,options)=>{
    const request=new Request(resource,options)
    if (new URL(request.url).port==='64590') return Response.json({ props:{pageProps:{article:{contentText:input.board.map(row=>`${row.nba_draft_number}. Mock Team selects ${row.display_name}`).join('\n')}}} })
    return await forwarding(request)
  }
  const articleFetch=globalThis.fetch
  globalThis.fetch=async(resource,options)=>{
    const request=new Request(resource,options)
    if (new URL(request.url).port==='64590') {
      const article=await (await articleFetch(request)).text()
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${article}</script>`)
    }
    return await articleFetch(request)
  }
}
let response
const headers={ 'content-type':'application/json',authorization:`Bearer ${input.jwt}`,'x-internal-function-token':'lineup-draft-private',...(!input.worker?{'x-request-id':'77777777-7777-4777-8777-777777777777'}:{}) }
if (input.name==='slot-move-today') {
  const clientModule='npm:@supabase/supabase-js@2.98.0'
  const { createClient }=await import(clientModule)
  const client=createClient('http://127.0.0.1:64521',deno.env.get('PANCAKE_SUPABASE_SECRET_KEY'),{ global:{headers:{Authorization:`Bearer ${input.jwt}`,'x-request-id':headers['x-request-id']},fetch:globalThis.fetch} })
  const result=await client.rpc('set_player_slot_moves_atomic',input.args)
  if(result.error) throw new Error(JSON.stringify(result.error))
  response=Response.json(result.data)
} else if(input.name==='auto-set-button') {
  const { handleApiRoute }=await import('../../supabase/functions/api/router.ts')
  response=await handleApiRoute(new Request('http://127.0.0.1:64521/functions/v1/api/league/lineup/auto-set-season',{method:'POST',headers,body:JSON.stringify(input.body)}))
} else if(input.worker) {
  response=await handlers[input.worker](new Request(`http://127.0.0.1:64521/functions/v1/${input.worker}`,{method:'POST',headers,body:JSON.stringify(input.body)}))
} else {
  const { handleApiRoute }=await import('../../supabase/functions/api/router.ts')
  const route=`/draft/${input.draft}/${input.action}`
  response=await handleApiRoute(new Request(`http://127.0.0.1:64521/functions/v1/api${route}`,{method:'POST',headers,body:JSON.stringify(input.body)}))
}
if (!response) throw new Error('No action response')
const body=await response.text()
if(response.status!==200) throw new Error(`${response.status}: ${body}`)
await pending
if(requests.some(request=>request.status>=400)) throw new Error('A required auth, database, or follow-up request failed')
console.log('RESULT '+JSON.stringify({ status:response.status,body,bytes:new TextEncoder().encode(body).byteLength,requests }))
deno.exit(0)
