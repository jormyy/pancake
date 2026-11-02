export async function compressApiResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers)
  const vary = headers.get('vary')?.split(',').map(value => value.trim()) ?? []
  if (!vary.some(value => value.toLowerCase() === 'accept-encoding')) headers.set('vary', [...vary, 'Accept-Encoding'].join(', '))
  const accepts = (request.headers.get('accept-encoding') ?? '').split(',').some(value => {
    const [name, ...params] = value.trim().toLowerCase().split(';')
    return name === 'gzip' && !params.some(param => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param))
  })
  if (!accepts || !response.body || response.headers.has('content-encoding') || !response.headers.get('content-type')?.includes('application/json')) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  const body = await response.arrayBuffer()
  if (body.byteLength < 1024) return new Response(body, { status: response.status, statusText: response.statusText, headers })
  const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  headers.set('content-encoding', 'gzip')
  headers.set('content-length', String(compressed.byteLength))
  return new Response(compressed, { status: response.status, statusText: response.statusText, headers })
}
