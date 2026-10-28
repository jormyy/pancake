import { requireInternalFunctionAuth } from './auth.ts'
import { internalServerError, logInternalError } from './responses.ts'
import { runEdgeInvocation } from './syncRuns.ts'
import { withWorkContext } from './workContext.ts'

// Standard runtime for internal (cron/service) functions: token auth, then a
// single catch that logs and returns a 500. Mirrors handleApiRequest in
// apiRuntime.ts, which serves the user-facing API instead.
export function serveInternal(
  scope: string,
  handler: (req: Request) => Promise<Response>,
): void {
  Deno.serve(async (req) => {
    const authError = requireInternalFunctionAuth(req)
    if (authError) return authError

    try {
      const requestId = req.headers.get('x-request-id')
      const requestActor = req.headers.get('x-request-actor')
      const run = () => runEdgeInvocation(scope, req, handler)
      const response = requestId && requestActor
        ? await withWorkContext({ signal: req.signal, requestId, requestActor }, run)
        : await run()
      if (response.status >= 500) logInternalError(scope, new Error(`Worker returned HTTP ${response.status}`))
      return response
    } catch (error) {
      return internalServerError(scope, error)
    }
  })
}
