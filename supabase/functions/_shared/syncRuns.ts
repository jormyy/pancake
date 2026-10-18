import { errorMessage } from './responses.ts'
import { supabase } from './supabase.ts'
import { withoutWorkContext } from './workContext.ts'

// Best-effort sync_runs bookkeeping keeps cron health queryable without putting
// observability writes on the critical path of the sync itself.
// `failure` lets a job that completed its loop but had per-item failures (for
// example one league out of many) record the run as failed with the summary
// while still returning its partial result to the caller.
export async function recordSyncRun<T>(
  functionName: string,
  run: () => Promise<{ result: T; rowsAffected: number | null; failure?: string | null }>,
  request?: Request,
): Promise<T> {
  const invocation = request ? invocationRuns.get(request) : undefined
  if (invocation) {
    try {
      const outcome = await run()
      invocation.rowsAffected = outcome.rowsAffected
      invocation.failure = outcome.failure ?? null
      return outcome.result
    } catch (error) {
      invocation.failure = errorMessage(error)
      throw error
    }
  }
  const startedId = await startSyncRun(functionName)

  try {
    const { result, rowsAffected, failure } = await run()
    if (failure && !startedId) {
      // The run row could not be opened, so the summary has nowhere to land; say so.
      console.error(`[${functionName}] run finished with failures but no sync_runs row could be recorded: ${failure}`)
    }
    if (startedId && failure) {
      await finishSyncRun(startedId, { status: 'failed', rows_affected: rowsAffected, error: failure }).catch(
        (updateError) => console.error(`[${functionName}] could not record partially failed sync run:`, updateError),
      )
      return result
    }
    if (startedId) {
      await finishSyncRun(startedId, { status: 'success', rows_affected: rowsAffected }).catch(
        (updateError) => console.error(`[${functionName}] could not record successful sync run:`, updateError),
      )
    }
    return result
  } catch (error) {
    // Record the failure but never let the bookkeeping mask the sync error.
    if (startedId) {
      await finishSyncRun(startedId, { status: 'failed', error: errorMessage(error) }).catch(
        (updateError) => console.error(`[${functionName}] could not record failed sync run:`, updateError),
      )
    }
    throw error
  }
}

async function startSyncRun(functionName: string): Promise<string | null> {
  return await withoutWorkContext(async () => {
    const { data, error } = await supabase
      .from('sync_runs')
      .insert({ function_name: functionName })
      .select('id')
      .abortSignal(AbortSignal.timeout(5000))
      .single()
    if (error) {
      console.error(`[${functionName}] could not start sync run record:`, error)
      return null
    }
    return data.id
  })
}

async function finishSyncRun(
  runId: string,
  fields: { status: 'success' | 'failed'; rows_affected?: number | null; error?: string },
): Promise<void> {
  await withoutWorkContext(async () => {
    const { error } = await supabase
      .from('sync_runs')
      .update({ finished_at: new Date().toISOString(), ...fields })
      .eq('id', runId)
      .abortSignal(AbortSignal.timeout(5000))
    if (error) throw error
  })
}

type InvocationRun = {
  functionName: string
  rowsAffected: number | null
  failure: string | null
}

const invocationRuns = new WeakMap<Request, InvocationRun>()

export async function runEdgeInvocation(
  functionName: string,
  request: Request,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get('x-pancake-invocation-id')
  if (!key) return await handler(request)
  const { error: startError } = await supabase.rpc('start_edge_invocation', {
    p_invocation_key: key, p_function_name: functionName,
  }).abortSignal(AbortSignal.timeout(5000))
  if (startError) throw startError
  const invocation: InvocationRun = { functionName, rowsAffected: null, failure: null }
  invocationRuns.set(request, invocation)
  let response: Response
  try {
    response = await handler(request)
    if (!response.ok && !invocation.failure) invocation.failure = `HTTP ${response.status}`
  } catch (error) {
    invocation.failure = errorMessage(error)
    await finishInvocation(key, invocation)
    throw error
  } finally {
    invocationRuns.delete(request)
  }
  await finishInvocation(key, invocation)
  return response
}

async function finishInvocation(key: string, invocation: InvocationRun): Promise<void> {
  try {
    const { error } = await supabase.rpc('finish_edge_invocation', {
      p_invocation_key: key,
      p_status: invocation.failure ? 'failed' : 'success',
      p_rows_affected: invocation.rowsAffected ?? undefined,
      p_error: invocation.failure ?? undefined,
    }).abortSignal(AbortSignal.timeout(5000))
    if (error) throw error
  } catch (error) {
    console.error(`[${invocation.functionName}] could not finish invocation:`, error)
  }
}
