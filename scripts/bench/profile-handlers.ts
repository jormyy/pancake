import { guardTarget } from './profile.ts'

type Handler = (request: Request) => Promise<Response>
type CachedResponse = { url: string; status: number; contentType: string | null; text: string; error?: string }

export function providerReadAllowed(request: Request) {
  if (request.headers.has('authorization') || request.headers.has('apikey')) return false
  if (request.method==='GET') return true
  const url=new URL(request.url)
  return request.method==='POST' && url.origin==='https://hashtagbasketball.com'
    && url.pathname==='/fantasy-basketball-dynasty-rankings'
    && request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')===true
}

export async function loadProfileHandlers(directory: string, names: string[]) {
  const realDate = Date
  const realFetch = globalThis.fetch
  const realServe = Deno.serve
  const instant = Date.parse('2026-03-14T12:00:00Z')
  globalThis.Date = new Proxy(realDate, {
    construct(target,args) { return Reflect.construct(target,args.length ? args : [instant]) },
    get(target,key) { return key === 'now' ? () => instant : Reflect.get(target,key) },
    apply() { return new realDate(instant).toString() },
  })
  const cache = `${directory}/providers`
  await Deno.mkdir(cache,{recursive:true})
  let localRequests=0,activeFetches=0,peakFetches=0
  const pending = new Map<string,Promise<CachedResponse>>()
  globalThis.fetch = async (input,init) => {
    const request = new Request(input,init)
    const url = new URL(request.url)
    if (['localhost','127.0.0.1'].includes(url.hostname)) {
      guardTarget(url.href,'56321')
      localRequests++
      activeFetches++
      peakFetches=Math.max(peakFetches,activeFetches)
      try { return await realFetch(request) } finally { activeFetches-- }
    }
    if (!providerReadAllowed(request)) throw Error('External providers must be anonymous reads')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.method==='GET' ? url.href : `POST\n${url.href}\n${await request.clone().text()}`)))).map(x => x.toString(16).padStart(2,'0')).join('')
    if (!pending.has(hash)) pending.set(hash,(async () => {
      const path = `${cache}/${hash}.json`
      try { return JSON.parse(await Deno.readTextFile(path)) as CachedResponse } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
      let saved: CachedResponse
      try {
        const response = await realFetch(request)
        saved = { url: url.href,status:response.status,contentType:response.headers.get('content-type'),text:await response.text() }
      } catch (error) { saved = { url:url.href,status:0,contentType:null,text:'',error:String(error) } }
      await Deno.writeTextFile(path,JSON.stringify(saved))
      return saved
    })())
    const saved = await pending.get(hash)!
    if (saved.error) throw Error(saved.error)
    return new Response(saved.text,{status:saved.status,headers:saved.contentType ? {'content-type':saved.contentType} : {}})
  }
  let current: Handler | undefined
  Object.defineProperty(Deno,'serve',{value:(callback:Handler) => { current=callback; return {} },configurable:true,writable:true})
  const handlers = new Map<string,Handler>()
  try {
    for (const name of names) {
      current=undefined
      await import(new URL(`../../supabase/functions/${name}/index.ts`,import.meta.url).href)
      if (!current) throw Error(`No handler registered for ${name}`)
      handlers.set(name,current)
    }
  } catch (error) {
    globalThis.Date=realDate
    globalThis.fetch=realFetch
    Object.defineProperty(Deno,'serve',{value:realServe})
    throw error
  }
  return { handlers,resetRequests:() => { localRequests=0;peakFetches=0 },requestStats:() => ({localRequests,peakFetches}),restore:() => {
    globalThis.Date=realDate
    globalThis.fetch=realFetch
    Object.defineProperty(Deno,'serve',{value:realServe})
  } }
}
