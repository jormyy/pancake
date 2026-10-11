export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return 'Request failed'
}

export function internalServerError(scope: string, error: unknown): Response {
  const requestId = crypto.randomUUID()
  console.error(`[${scope}]`, { requestId, error })
  return Response.json(
    { ok: false, error: 'Internal server error', requestId },
    { status: 500 },
  )
}
