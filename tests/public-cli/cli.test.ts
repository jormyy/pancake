import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../../packages/pancake-cli/bin/pancake.mjs'
import contract from '../../packages/pancake-cli/schemas/v2.json'
import fixture from '../fixtures/public-cli/league-v2.json'

const league='11111111-1111-4111-8111-111111111111'
const temporary:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(temporary.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))})
async function invoke(args:string[],extra:Record<string,unknown>={}) {
  let stdout='',stderr=''
  const code=await run(args,{stdout:{isTTY:false,write:(value:string)=>{stdout+=value}},stderr:{write:(value:string)=>{stderr+=value}},env:{},...extra})
  return {code,stdout,stderr}
}
const args=['teams','--league',league,'--api-url','http://localhost:58921','--no-cache']
describe('public CLI v2',()=>{
  it.each(Object.keys(contract.resources))('reads %s without credentials',async name=>{
    const result=await invoke([name,'--fixture','tests/fixtures/public-cli/league-v2.json',...(name==='leagues'?[]:['--league',league]),...(name==='rosters'?['--team',league]:[])])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).version).toBe(2)
    expect(JSON.parse(result.stdout).items).toHaveLength(1)
    expect(result.stderr).toBe('')
  })
  it('describes commands offline and removes the operator command',async()=>{
    const description=JSON.parse((await invoke(['describe'])).stdout)
    expect(description.commands).toContain('leagues')
    expect(description.commands).not.toContain('db-health')
    expect((await invoke(['db-health'])).code).toBe(2)
    expect((await invoke(['teams','--token','secret'])).code).toBe(2)
    expect((await invoke(['explain','trades.completedAt'])).code).toBe(0)
  })
  it('sends no authorization and retries only safe transient failures',async()=>{
    let calls=0
    const result=await invoke(args,{fetch:async(url:string,init:RequestInit)=>{
      expect(url).toContain('/public/v2/teams')
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      calls++
      return calls<3?new Response('',{status:503}):Response.json(fixture.resources.teams)
    }})
    expect(result.code).toBe(0)
    expect(calls).toBe(3)
  })
  it.each([[400,2],[404,4],[429,5],[500,7]])('maps HTTP %i to exit %i',async(status,code)=>{
    let calls=0
    const result=await invoke(args,{fetch:async()=>{calls++;return new Response('SECRET',{status})}})
    expect(result.code).toBe(code)
    expect(calls).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('SECRET')
  })
  it.each([502,503,504])('retains HTTP %i failure when the retry budget expires',async status=>{
    const controller=new AbortController()
    vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal)
    let calls=0
    const result=await invoke(args,{fetch:async()=>{
      calls++
      controller.abort()
      return new Response('PRIVATE SERVER DETAIL',{status})
    }})
    expect(result.code).toBe(7)
    expect(calls).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('PRIVATE SERVER DETAIL')
    expect(result.stderr).not.toContain('Could not reach')
  })
  it.each([false,true])('classifies a transport timeout after an earlier response=%s',async answered=>{
    const controller=new AbortController()
    vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal)
    let calls=0
    const result=await invoke(args,{fetch:async()=>{
      if(answered && calls++===0)return new Response('',{status:503})
      controller.abort()
      throw new DOMException('aborted','AbortError')
    }})
    expect(result.code).toBe(answered?7:6)
    expect(result.stdout).toBe('')
  })
  it.each([{}, {PANCAKE_API_URL:'http://localhost:58921'}])('rejects missing scope locally with instructions',async env=>{
    let calls=0
    const fetch=async()=>{calls++;throw new Error('network must not run')}
    const missing=await invoke(['standings','--json'],{env,fetch})
    expect(missing.code).toBe(2)
    expect(missing.stdout).toBe('')
    expect(JSON.parse(missing.stderr).error.message).toBe('--league is required; run `pancake leagues` to find league IDs')
    const roster=await invoke(['rosters','--league',league,'--json'],{env,fetch})
    expect(roster.code).toBe(2)
    expect(JSON.parse(roster.stderr).error.message).toContain('pancake teams --league ID')
    expect(calls).toBe(0)
  })
  it.each(['league','team','player','draft','trade'])('rejects malformed --%s locally',async key=>{
    let calls=0
    const result=await invoke(['teams',...(key==='league'?[]:['--league',league]),`--${key}`,'bad'],{fetch:async()=>{calls++;throw new Error('network must not run')}})
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error.message).toContain(`--${key} must be a UUID`)
    expect(calls).toBe(0)
  })
  it.each(['league','team','player','draft','trade'])('explains a bare --%s option',async key=>{
    const result=await invoke(['teams',`--${key}`],{fetch:async()=>{throw new Error('network must not run')}})
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stderr).error.message).toContain('run `pancake')
  })
  it('distinguishes a valid but absent public ID',async()=>{
    expect((await invoke(args,{fetch:async()=>new Response('',{status:404})})).code).toBe(4)
  })
  it('uses the documented production default and explicit URL overrides',async()=>{
    const urls:string[]=[]
    const fetch=async(url:string)=>{urls.push(url);return Response.json(fixture.resources.leagues)}
    expect((await invoke(['leagues','--json','--no-cache'],{fetch})).code).toBe(0)
    expect((await invoke(['leagues','--no-cache'],{env:{PANCAKE_API_URL:'http://localhost:58921'},fetch})).code).toBe(0)
    expect((await invoke(['leagues','--api-url','http://127.0.0.1:58922','--no-cache'],{env:{PANCAKE_API_URL:'http://localhost:58921'},fetch})).code).toBe(0)
    expect(urls.map(url=>new URL(url).origin)).toEqual(['https://ceeytbfmwsnzalxlkalc.supabase.co','http://localhost:58921','http://127.0.0.1:58922'])
    expect(urls[0]).toContain('/functions/v1/api/public/v2/leagues')
  })
  it('enforces output bounds and schema versions',async()=>{
    expect((await invoke(args,{fetch:async()=>new Response('x'.repeat(2097153))})).code).toBe(7)
    expect((await invoke(args,{fetch:async()=>Response.json({...fixture.resources.teams,version:1})})).code).toBe(7)
    expect((await invoke(args,{fetch:async()=>Response.json({...fixture.resources.teams,private:'SECRET'})})).code).toBe(7)
  })
  it.each([204,200])('classifies an empty HTTP %i body as an invalid server response',async status=>{
    let calls=0
    const result=await invoke(args,{fetch:async()=>{calls++;return new Response(null,{status})}})
    expect(result.code).toBe(7)
    expect(result.stdout).toBe('')
    expect(calls).toBe(1)
  })
  it('classifies an interrupted HTTP response as a server failure',async()=>{
    const body=new ReadableStream({start(controller){controller.error(new TypeError('terminated'))}})
    const result=await invoke(args,{fetch:async()=>new Response(body)})
    expect(result.code).toBe(7)
    expect(result.stdout).toBe('')
  })
  it('does not retry unexpected response failures as network errors',async()=>{
    let calls=0
    const result=await invoke(args,{fetch:async()=>{calls++;throw new Error('invalid response implementation')}})
    expect(result.code).toBe(7)
    expect(calls).toBe(1)
  })
  it.each(['asc','desc'])('breaks tied custom draft sorts by ascending ID with %s primary direction',async direction=>{
    const directory=await mkdtemp(path.join(tmpdir(),'public-cli-ties-'));temporary.push(directory)
    const data=structuredClone(fixture)
    const high='ffffffff-ffff-4fff-8fff-ffffffffffff'
    const low='00000000-0000-4000-8000-000000000000'
    data.resources.drafts.items=[{...data.resources.drafts.items[0],id:high},{...data.resources.drafts.items[0],id:low}]
    const filename=path.join(directory,'ties.json')
    await writeFile(filename,JSON.stringify(data))
    const options=['drafts','--league',league,'--fixture',filename,'--sort','seasonYear','--direction',direction,'--limit','1']
    const first=JSON.parse((await invoke(options)).stdout)
    expect(first.items[0].id).toBe(low)
    const second=JSON.parse((await invoke([...options,'--cursor',first.nextCursor])).stdout)
    expect(second.items[0].id).toBe(high)
    expect(second.nextCursor).toBeNull()
  })
  it('revalidates public cache entries without token-based keys',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'public-cli-cache-'));temporary.push(directory)
    let calls=0
    const fetch=async(_url:string,init:RequestInit)=>{
      calls++
      if(calls===1)return Response.json(fixture.resources.teams,{headers:{etag:'"public"'}})
      expect(new Headers(init.headers).get('if-none-match')).toBe('"public"')
      return new Response(null,{status:304})
    }
    const options=['teams','--league',league,'--api-url','http://localhost:58921','--cache-dir',directory]
    expect(await invoke(options,{fetch})).toEqual(await invoke(options,{fetch}))
    const files=await readdir(directory)
    expect(files).toHaveLength(1)
    expect(await readFile(path.join(directory,files[0]),'utf8')).not.toContain('token')
  })
})
