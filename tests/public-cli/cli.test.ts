import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../../packages/pancake-cli/bin/pancake.mjs'
import contract from '../../packages/pancake-cli/schemas/v2.json'
import fixture from '../fixtures/public-cli/league-v2.json'

const league='11111111-1111-4111-8111-111111111111'
const temporary:string[]=[]
afterEach(async()=>{await Promise.all(temporary.splice(0).map(dir=>rm(dir,{recursive:true,force:true})))})
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
  it('uses identical missing-resource errors for missing and malformed IDs',async()=>{
    const missing=await invoke(['teams'])
    const malformed=await invoke(['teams','--league','bad'])
    const absent=await invoke(args,{fetch:async()=>new Response('',{status:404})})
    expect(missing).toEqual(malformed)
    expect(missing).toEqual(absent)
  })
  it('enforces output bounds and schema versions',async()=>{
    expect((await invoke(args,{fetch:async()=>new Response('x'.repeat(2097153))})).code).toBe(7)
    expect((await invoke(args,{fetch:async()=>Response.json({...fixture.resources.teams,version:1})})).code).toBe(7)
    expect((await invoke(args,{fetch:async()=>Response.json({...fixture.resources.teams,private:'SECRET'})})).code).toBe(7)
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
