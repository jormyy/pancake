import { requireInternalFunctionAuth } from './auth.ts'
import { internalServerError } from './responses.ts'
import { runEdgeInvocation } from './syncRuns.ts'

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
      return await runEdgeInvocation(scope, req, handler)
    } catch (error) {
      return internalServerError(scope, error)
    }
  })
}
