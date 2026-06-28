function internalTokens(): string[] {
  return [
    Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN'),
    Deno.env.get('EDGE_FUNCTION_INTERNAL_TOKEN'),
  ].filter((token): token is string => Boolean(token && token.trim().length > 0))
}

function internalHeaderToken(req: Request): string | null {
  return req.headers.get('x-internal-function-token')?.trim() || null
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const maxLength = Math.max(a.length, b.length)

  for (let i = 0; i < maxLength; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }

  return diff === 0
}

export function requireInternalFunctionAuth(req: Request): Response | null {
  const allowedTokens = internalTokens()
  if (allowedTokens.length === 0) {
    console.error('[edge-auth] no internal function token configured')
    return Response.json(
      { ok: false, error: 'Internal function authorization is not configured' },
      { status: 500 },
    )
  }

  const token = internalHeaderToken(req)
  if (!token) {
    return Response.json({ ok: false, error: 'Missing internal authorization' }, { status: 401 })
  }

  if (allowedTokens.some((allowed) => constantTimeEqual(token, allowed))) return null

  return Response.json({ ok: false, error: 'Forbidden' }, { status: 403 })
}
