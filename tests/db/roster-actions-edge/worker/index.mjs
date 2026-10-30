import { observeDatabaseBytes } from '../../roster-actions-edge-bytes.mjs'

const serve = globalThis.Deno.serve
const observe = observeDatabaseBytes()
const handlers = []
Object.defineProperty(globalThis.Deno, 'serve', { value: handler => { handlers.push(handler) } })
await import('../../roster-actions-worker-baseline.mjs')
await import('../../../../supabase/functions/process-waivers/index.ts')
Object.defineProperty(globalThis.Deno, 'serve', { value: serve })
serve(observe(request => handlers[request.headers.get('x-roster-case')?.endsWith('/baseline') ? 0 : 1](request)))
