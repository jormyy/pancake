export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function internalServerError(scope: string, error: unknown): Response {
  const requestId = crypto.randomUUID()
  console.error(`[${scope}]`, { requestId, error })
  return Response.json(
    { ok: false, error: 'Internal server error', requestId },
    { status: 500 },
  )
}
