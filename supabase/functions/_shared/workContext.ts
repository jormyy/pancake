import { AsyncLocalStorage } from 'node:async_hooks'

type WorkContext = { signal: AbortSignal; renewLease?: () => Promise<void>; livePollHolder?: string; workInvocation?: string; requestId?: string; requestActor?: string }
const workContext = new AsyncLocalStorage<WorkContext>()

export function withWorkContext<T>(context: WorkContext, run: () => Promise<T>): Promise<T> {
  const parent = workContext.getStore()
  return workContext.run(parent ? { ...parent, ...context, signal: AbortSignal.any([parent.signal, context.signal]) } : context, run)
}

export function withoutWorkContext<T>(run: () => T): T {
  return workContext.exit(run)
}

function currentWorkContext(): WorkContext | undefined {
  return workContext.getStore()
}

export async function renewCurrentWorkLease(): Promise<void> {
  const context = currentWorkContext()
  context?.signal.throwIfAborted()
  await context?.renewLease?.()
  context?.signal.throwIfAborted()
}

export function setRequestActor(actor: string): void {
  const context = currentWorkContext()
  if (context) context.requestActor = actor
}

export function requestHeaders(): Record<string, string> {
  const context = currentWorkContext()
  return context?.requestId && context.requestActor
    ? { 'x-request-id': context.requestId, 'x-request-actor': context.requestActor }
    : {}
}

export function workFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const context = currentWorkContext()
  if (!context) return fetch(input, init)
  context.signal.throwIfAborted()
  const outer = init?.signal ?? (input instanceof Request ? input.signal : null)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const url = new URL(input instanceof Request ? input.url : input)
  const databaseUrl = typeof Deno === 'undefined' ? undefined : Deno.env.get('SUPABASE_URL')
  const databaseOrigin = databaseUrl ? new URL(databaseUrl).origin : null
  if (context.livePollHolder && url.origin === databaseOrigin) headers.set('x-pancake-live-holder', context.livePollHolder)
  else headers.delete('x-pancake-live-holder')
  if (context.workInvocation && url.origin === databaseOrigin) headers.set('x-pancake-work-key', context.workInvocation)
  else headers.delete('x-pancake-work-key')
  headers.delete('x-request-id')
  headers.delete('x-request-actor')
  if (url.origin === databaseOrigin && url.pathname.startsWith('/rest/v1/rpc/')) {
    for (const [name, value] of Object.entries(requestHeaders())) headers.set(name, value)
  }
  return fetch(input, {
    ...init,
    headers,
    signal: outer ? AbortSignal.any([outer, context.signal]) : context.signal,
  })
}
