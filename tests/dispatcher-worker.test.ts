import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  vacuum: vi.fn(),
  handler: null as null | ((request: Request) => Promise<Response>),
}))

vi.mock('../supabase/functions/_shared/supabase.ts', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../supabase/functions/_shared/workContext.ts', () => ({
  renewCurrentWorkLease: vi.fn(),
  withoutWorkContext: (run: () => unknown) => run(),
  withWorkContext: (_context: unknown, run: () => unknown) => run(),
}))
vi.mock('../supabase/functions/_shared/serve.ts', () => ({
  serveInternal: (_scope: string, handler: (request: Request) => Promise<Response>) => { mocks.handler = handler },
}))
vi.mock('../supabase/functions/dispatcher/postgres.ts', () => ({ vacuumResponses: mocks.vacuum }))

const dispatcherPath = '../supabase/functions/dispatcher/index.ts'
const invocationPath = '../supabase/functions/_shared/syncRuns.ts'
await import(dispatcherPath)
const { runEdgeInvocation } = await import(invocationPath)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  mocks.rpc.mockReset()
  mocks.vacuum.mockReset()
})

it('records the vacuum timeout against its work item and completes the next hour', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('Deno', { env: { get: (key: string) => key === 'SUPABASE_DB_URL' ? 'postgresql://postgres@127.0.0.1:58522/postgres' : undefined } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: true, error: null }) }))
  const failure = new Error('vacuum timed out after 20 s')
  mocks.vacuum.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
  const request = (hour: number) => new Request('http://127.0.0.1:58521/functions/v1/dispatcher', {
    method: 'POST',
    headers: { 'x-pancake-invocation-id': `hour-${hour}`, 'x-pancake-work-id': `${hour}` },
    body: JSON.stringify({ action: 'vacuum' }),
  })
  await expect(runEdgeInvocation('dispatcher', request(21), mocks.handler!)).rejects.toBe(failure)
  expect(mocks.rpc).toHaveBeenCalledWith('finish_edge_invocation', {
    p_invocation_key: 'hour-21', p_status: 'failed', p_rows_affected: undefined, p_error: failure.message,
  })
  await vi.advanceTimersByTimeAsync(3_600_000)
  const response = await runEdgeInvocation('dispatcher', request(22), mocks.handler!)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(mocks.rpc).toHaveBeenCalledWith('finish_edge_invocation', {
    p_invocation_key: 'hour-22', p_status: 'success', p_rows_affected: undefined, p_error: undefined,
  })
  expect(vi.getTimerCount()).toBe(0)
})
