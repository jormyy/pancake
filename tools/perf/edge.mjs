import { handleApiRoute } from '../../supabase/functions/api/router.ts'

const runtime = globalThis.Deno
const nativeFetch = globalThis.fetch
const target = new URL(runtime.env.get('SUPABASE_URL'))
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== target.origin) throw new Error('Perf Edge blocks external requests')
  return nativeFetch(request)
}
globalThis.EdgeRuntime = { waitUntil: promise => promise.catch(error => console.error(error.message)) }
runtime.serve({ hostname: '127.0.0.1', port: Number(runtime.env.get('PERF_EDGE_PORT')) }, handleApiRoute)
