import { labTarget } from './target.mjs'

const { ports } = labTarget()

export function internalEdgeRequest(request) {
  const url = new URL(request.url)
  if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && url.port === String(ports.api) && url.pathname.startsWith('/functions/v1/')) {
    url.port = String(ports.edge)
    return new Request(url, request)
  }
  return request
}
