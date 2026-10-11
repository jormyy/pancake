import { fetchCdnGameOrMiss } from './cdnGameFetch.ts'

Deno.test('CDN import deadline includes an unfinished native HTTP response body', async () => {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller
      controller.enqueue(new TextEncoder().encode('{"game":'))
    } }), { headers: { 'Content-Type': 'application/json' } }))
  let limit: ReturnType<typeof setTimeout> | undefined
  const work = fetchCdnGameOrMiss('body-stall', `http://127.0.0.1:${server.addr.port}`)
    .then(() => 'resolved', (error) => error instanceof DOMException ? error.name : String(error))
  try {
    const outcome = await Promise.race([work, new Promise<string>((resolve) => {
      limit = setTimeout(() => resolve('deadline missed'), 12_500)
    })])
    if (outcome !== 'AbortError') throw new Error(`Body deadline result: ${outcome}`)
  } finally {
    clearTimeout(limit)
    try { body?.enqueue(new TextEncoder().encode('null}')); body?.close() } catch { /* Native abort closes the stream. */ }
    await work
    await server.shutdown()
  }
})

Deno.test('CDN import retains successful JSON, missing-game, and provider-error behavior', async () => {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
    const url = new URL(request.url)
    if (url.pathname.includes('missing')) return new Response('missing', { status: 404 })
    if (url.pathname.includes('forbidden')) return new Response('retry later', { status: 403 })
    return Response.json({ game: { gameStatus: 3, gameEt: '2026-10-11T20:00:00' } })
  })
  const base = `http://127.0.0.1:${server.addr.port}`
  try {
    const game = await fetchCdnGameOrMiss('valid', base)
    if (game === 'missing' || game?.gameStatus !== 3) throw new Error('Completed JSON was not returned')
    if (await fetchCdnGameOrMiss('missing', base) !== 'missing') throw new Error('404 classification changed')
    const forbidden = await fetchCdnGameOrMiss('forbidden', base).then(() => null, (error) => String(error))
    if (!forbidden?.includes('CDN 403')) throw new Error('403 was not retryable failure')
  } finally { await server.shutdown() }
})

Deno.test('CDN status classification survives an already errored native response stream', async () => {
  const nativeFetch = globalThis.fetch
  let status = 404
  globalThis.fetch = () => Promise.resolve(new Response(new ReadableStream({
    start(controller) { controller.error(new Error('body connection ended')) },
  }), { status }))
  try {
    if (await fetchCdnGameOrMiss('errored-body', 'http://127.0.0.1') !== 'missing') {
      throw new Error('Known 404 classification changed')
    }
    status = 403
    const error = await fetchCdnGameOrMiss('errored-body', 'http://127.0.0.1').then(() => null, String)
    if (!error?.includes('CDN 403')) throw new Error('Known provider status was lost')
  } finally { globalThis.fetch = nativeFetch }
})
