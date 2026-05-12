export function internalServerError(scope: string, error: unknown): Response {
  const requestId = crypto.randomUUID()
  console.error(`[${scope}]`, { requestId, error })
  return Response.json(
    { ok: false, error: 'Internal server error', requestId },
    { status: 500 },
  )
}
