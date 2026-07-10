const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  if (new URL(req.url).pathname !== '/functions/v1/slow-body') return Response.json({ ok: true })

  let timer: number | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'))
        controller.close()
      }, 250)
    },
    cancel() {
      clearTimeout(timer)
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/json' } })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_timeout_test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'edge-timeout-test')

const { invokeInternalFunction } = await import('./apiRuntime.ts')

Deno.test({
  name: 'internal invocation deadline aborts while reading a stalled response body',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      await invokeInternalFunction('slow-body', {}, { timeoutMs: 20 })
      throw new Error('stalled response unexpectedly completed')
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : null
      if (status !== 504 || !(error instanceof Error) || !error.message.includes('slow-body')) throw error
    } finally {
      await server.shutdown()
    }
  },
})
