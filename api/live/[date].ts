import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLiveHandler } from '../../server/live/handler.ts'

const liveHandler = createLiveHandler()

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const result = await liveHandler(new Request(`http://localhost${request.url ?? '/'}`, { method: request.method ?? 'GET' }))
  response.statusCode = result.status
  for (const [name,value] of result.headers) response.setHeader(name,value)
  response.end(request.method === 'HEAD' ? undefined : await result.text())
}
