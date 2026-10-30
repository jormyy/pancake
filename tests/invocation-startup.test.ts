import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({rpc:vi.fn(),signal:null as AbortSignal|null}))
vi.mock('../supabase/functions/_shared/supabase.ts',()=>({supabase:{rpc:mocks.rpc}}))
vi.mock('../supabase/functions/_shared/workContext.ts',()=>({
  withoutWorkContext:(run:()=>unknown)=>run(),
  withWorkContext:(context:{signal:AbortSignal},run:()=>unknown)=>{mocks.signal=context.signal;return run()},
}))
const invocationPath='../supabase/functions/_shared/syncRuns.ts'
const {runEdgeInvocation,recordSyncRun}=await import(invocationPath)
const request=(leased=true)=>new Request('http://127.0.0.1:62321/functions/v1/sync-players',{
  method:'POST',headers:{'x-pancake-invocation-id':'test-key',...(leased?{'x-pancake-work-id':'42'}:{})},
})
beforeEach(()=>{
  vi.useFakeTimers()
  vi.stubGlobal('Deno',{env:{get:()=>undefined}})
  mocks.rpc.mockImplementation(()=>({abortSignal:async()=>({data:true,error:null})}))
  vi.spyOn(console,'error').mockImplementation(()=>{})
})
afterEach(()=>{
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();mocks.rpc.mockReset();mocks.signal=null
})

it('combines leased startup and initial renewal while retaining the finish receipt',async()=>{
  const handler=vi.fn(async()=>new Response('ok'))
  expect((await runEdgeInvocation('sync-players',request(),handler)).status).toBe(200)
  expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(['start_work_invocation','finish_edge_invocation'])
  expect(mocks.rpc).toHaveBeenCalledWith('start_work_invocation',{p_invocation_key:'test-key',p_function_name:'sync-players'})
  expect(handler).toHaveBeenCalledOnce()
})

it('keeps unleased startup on the existing RPC',async()=>{
  await runEdgeInvocation('sync-players',request(false),async()=>new Response('ok'))
  expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(['start_edge_invocation','finish_edge_invocation'])
})

it('keeps requests without an invocation key outside bookkeeping',async()=>{
  await runEdgeInvocation('sync-players',new Request('http://127.0.0.1:62321'),async()=>new Response('ok'))
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('does not run the handler or finish after startup rejects a lease',async()=>{
  const failure=new Error('Work lease is no longer current')
  mocks.rpc.mockImplementation(()=>({abortSignal:async()=>({data:null,error:failure})}))
  const handler=vi.fn(async()=>new Response('ok'))
  await expect(runEdgeInvocation('sync-players',request(),handler)).rejects.toBe(failure)
  expect(handler).not.toHaveBeenCalled()
  expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(['start_work_invocation'])
})

it('continues renewing long work every thirty seconds',async()=>{
  let finish!:(response:Response)=>void
  const pending=runEdgeInvocation('sync-players',request(),()=>new Promise<Response>(resolve=>{finish=resolve}))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(['start_work_invocation','renew_work_lease'])
  finish(new Response('ok'))
  await pending
})

it('aborts work and records a failure when a later heartbeat loses its lease',async()=>{
  mocks.rpc.mockImplementation((name:string)=>({abortSignal:async()=>({data:name!=='renew_work_lease',error:null})}))
  let finish!:(response:Response)=>void
  const pending=runEdgeInvocation('sync-players',request(),()=>new Promise<Response>(resolve=>{finish=resolve}))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mocks.signal?.aborted).toBe(true)
  finish(new Response('ok'))
  await expect(pending).rejects.toThrow('Work lease lost')
  expect(mocks.rpc).toHaveBeenCalledWith('finish_edge_invocation',expect.objectContaining({p_status:'failed',p_error:'Work lease lost'}))
})

it('retains partial failure evidence from a successful HTTP response',async()=>{
  const req=request()
  await runEdgeInvocation('sync-players',req,()=>recordSyncRun('sync-players',async()=>({result:new Response('ok'),rowsAffected:4,failure:'one item failed'}),req))
  expect(mocks.rpc).toHaveBeenCalledWith('finish_edge_invocation',expect.objectContaining({p_status:'failed',p_rows_affected:4,p_error:'one item failed'}))
})
