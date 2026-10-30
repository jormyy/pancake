import { AsyncLocalStorage } from 'node:async_hooks'

type WorkContext = { signal: AbortSignal; renewLease?: () => Promise<void>; livePollHolder?: string; workInvocation?: string; requestId?: string; requestActor?: string; retryScoreInputs?: boolean; onScoreInputRetry?: () => void }
const workContext = new AsyncLocalStorage<WorkContext>()

export function withWorkContext<T>(context: WorkContext, run: () => Promise<T>): Promise<T> {
  const parent = workContext.getStore()
  return workContext.run(parent ? { ...parent, ...context, signal: AbortSignal.any([parent.signal, context.signal]) } : context, run)
}

export function withLiveScoreRetries<T>(run: () => Promise<T>, onRetry?: () => void): Promise<T> {
  const context = workContext.getStore()
  return context?.livePollHolder ? workContext.run({ ...context, retryScoreInputs: true, onScoreInputRetry: onRetry }, run) : run()
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

export async function workFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
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
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, {
      ...init,
      headers,
      signal: outer ? AbortSignal.any([outer, context.signal]) : context.signal,
    })
    if (response.ok || !context.livePollHolder || url.origin !== databaseOrigin || !url.pathname.startsWith('/rest/v1/rpc/')) return response
    const error = await response.clone().json().catch(() => ({}))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const rpc = url.pathname.split('/').at(-1)
    const details = { rpc, gameId: body.p_game_id, providerGameId: body.p_provider_game_id,
      leagueId: body.p_league_id, seasonId: body.p_league_season_id, week: body.p_week_number,
      code: error.code, message: error.message, details: error.details }
    const scoreRpc = ['capture_score_inputs', 'get_stale_score_weeks', 'update_score_points_atomic', 'finalize_score_week_atomic'].includes(rpc ?? '')
    const contention = ['55P03', '40P01', '40001'].includes(error.code) ||
      error.code === 'PT409' && error.message === 'Game inputs are being updated. Retry this operation.'
    if (context.retryScoreInputs && scoreRpc && contention && attempt < 3 && !context.signal.aborted && !outer?.aborted) {
      context.onScoreInputRetry?.()
      console.warn('[live-poll] retrying score input:', JSON.stringify({ ...details, attempt: attempt + 1 }))
      await response.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt))
      context.signal.throwIfAborted()
      outer?.throwIfAborted()
      continue
    }
    console.error('[live-poll] database input failed:', JSON.stringify(details))
    return response
  }
}
