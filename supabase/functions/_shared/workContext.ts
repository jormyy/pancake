import { AsyncLocalStorage } from 'node:async_hooks'

type WorkContext = { signal: AbortSignal; livePollHolder?: string }
const workContext = new AsyncLocalStorage<WorkContext>()
const databaseUrl = Deno.env.get('SUPABASE_URL')
const databaseOrigin = databaseUrl ? new URL(databaseUrl).origin : null

export function withWorkContext<T>(context: WorkContext, run: () => Promise<T>): Promise<T> {
  return workContext.run(context, run)
}

export function withoutWorkContext<T>(run: () => T): T {
  return workContext.exit(run)
}

function currentWorkContext(): WorkContext | undefined {
  return workContext.getStore()
}

export function workFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const context = currentWorkContext()
  if (!context) return fetch(input, init)
  context.signal.throwIfAborted()
  const outer = init?.signal ?? (input instanceof Request ? input.signal : null)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const url = new URL(input instanceof Request ? input.url : input)
  if (context.livePollHolder && url.origin === databaseOrigin) headers.set('x-pancake-live-holder', context.livePollHolder)
  else headers.delete('x-pancake-live-holder')
  return fetch(input, {
    ...init,
    headers,
    signal: outer ? AbortSignal.any([outer, context.signal]) : context.signal,
  })
}
