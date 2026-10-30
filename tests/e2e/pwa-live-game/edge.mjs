import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const runtime = globalThis['Deno']
const contexts = new AsyncLocalStorage()
const nativeFetch = globalThis.fetch
const nativeServe = runtime.serve
const directory = runtime.env.get('PERF_LAB_EVIDENCE')
const digest = value => createHash('sha256').update(value).digest('hex')
globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const context = contexts.getStore()
    const result = await nativeFetch(request)
    if (context && (url.pathname.startsWith('/rest/v1/') || url.pathname === '/auth/v1/user')) {
        appendFileSync(path.join(directory, 'client-db-calls.jsonl'), `${JSON.stringify({ at: Date.now(), ...context, endpoint: url.pathname, status: result.status })}\n`)
    }
    return result
}
Object.defineProperty(runtime, 'serve', { configurable: true, value: (options, handler) => nativeServe(options, request => {
    const authorization = request.headers.get('authorization')
    return contexts.run({ origin: request.headers.get('origin'), identity: authorization ? digest(authorization) : null, parent: new URL(request.url).pathname }, () => handler(request))
}) })
await import('../../../scripts/perf-lab/edge.mjs')
