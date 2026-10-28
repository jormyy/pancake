export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return 'Request failed'
}

function safeErrorText(value: string): string {
  let text = value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  for (const name of ['PANCAKE_EDGE_INTERNAL_TOKEN', 'EDGE_FUNCTION_INTERNAL_TOKEN', 'PANCAKE_SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const secret = Deno.env.get(name)
    if (secret && secret.length >= 4) text = text.split(secret).join('[redacted]')
  }
  return text
}

export function logInternalError(scope: string, error: unknown, requestId = crypto.randomUUID()): void {
  const message = errorMessage(error)
  const stack = error instanceof Error ? error.stack : error && typeof error === 'object' && 'stack' in error && typeof error.stack === 'string' ? error.stack : new Error(message).stack
  console.error(`[${scope}]`, JSON.stringify({ requestId, message: safeErrorText(message), stack: safeErrorText(stack ?? message) }))
}

export function internalServerError(scope: string, error: unknown): Response {
  const requestId = crypto.randomUUID()
  logInternalError(scope, error, requestId)
  return Response.json(
    { ok: false, error: 'Internal server error', requestId },
    { status: 500 },
  )
}
