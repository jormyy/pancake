import { AsyncLocalStorage } from 'node:async_hooks'

export function observeDatabaseBytes() {
  const requests = new AsyncLocalStorage()
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init)
    const request = requests.getStore()
    const url = new URL(input instanceof Request ? input.url : input)
    if (request && (url.pathname.startsWith('/rest/v1/') || url.pathname === '/auth/v1/user')) {
      const bytes = (await response.clone().arrayBuffer()).byteLength
      console.log(JSON.stringify({ event: 'roster-actions-db-bytes', case: request, path: url.pathname, status: response.status, bytes }))
    }
    return response
  }
  return handler => request => requests.run(request.headers.get('x-roster-case'), () => handler(request))
}
