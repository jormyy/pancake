import contract from './schema.json' with { type: 'json' }

export const publicContract = contract
export type Resource = keyof typeof contract.resources
export const resourceNames = Object.keys(contract.resources) as Resource[]
type Shape = { type?: string | string[]; const?: unknown; enum?: unknown[]; properties?: Record<string, Shape>; items?: Shape }

export function publicValue(value: unknown, schema: Shape): unknown {
  if (schema.const !== undefined) {
    if (value !== schema.const) throw new Error('Invalid public response')
    return value
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (value === null || value === undefined) {
    if (types.includes('null')) return null
    throw new Error('Missing public field')
  }
  if (types.includes('object')) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public object')
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, shape]) => [key, publicValue(record[key], shape)]))
  }
  if (types.includes('array')) {
    if (!Array.isArray(value)) throw new Error('Invalid public list')
    return value.map(item => publicValue(item, schema.items!))
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error('Invalid public enum')
  if (types.includes('integer') && typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (types.includes('number') && typeof value === 'number' && Number.isFinite(value)) return value
  if (types.includes(typeof value)) return value
  throw new Error('Invalid public field')
}


export type PublicRead = (token: string, resource: Resource, params: Record<string, unknown>) => Promise<{
  status: number; items?: unknown[]; hasMore?: boolean; retryAfter?: number
}>
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
  'Vary': 'Authorization',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, if-none-match, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After',
  'X-Content-Type-Options': 'nosniff',
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const messages: Record<number, string> = { 400: 'Invalid request', 401: 'Valid league share token required', 404: 'Public resource not found', 405: 'Read-only endpoint', 429: 'Read limit reached', 503: 'Public data unavailable' }
function failure(status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ $schema: 'urn:pancake:public:v1:error', version: 1, error: { code: status, message: messages[status] ?? messages[503] } }), { status, headers: { ...headers, 'Cache-Control': 'no-store', ...extra } })
}
async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
function number(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback
  if (!/^[0-9]+$/.test(value)) throw new Error('Invalid number')
  const result = Number(value)
  if (result < 1 || result > max) throw new Error('Invalid number')
  return result
}
export function createPublicHandler(read: PublicRead) {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (path !== '/public/v1' && !path.startsWith('/public/v1/')) return null
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'GET') return failure(405, { Allow: 'GET, OPTIONS' })
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token) return failure(401)
    const name = path.slice('/public/v1/'.length)
    if (!resourceNames.includes(name as Resource)) return failure(404)
    const resource = name as Resource
    try {
      const url = new URL(request.url)
      const allowed = ['limit', 'cursor', 'season', 'week', 'team', 'player', 'query', 'position']
      for (const key of url.searchParams.keys()) {
        if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400)
      }
      const limit = number(url.searchParams.get('limit'), 25, 50)
      const params: Record<string, unknown> = { limit }
      if (url.searchParams.has('season')) params.seasonYear = number(url.searchParams.get('season'), 0, 2200)
      if (url.searchParams.has('week')) params.weekNumber = number(url.searchParams.get('week'), 0, 60)
      for (const [key, mapped] of [['team', 'targetMemberId'], ['player', 'playerId']] as const) {
        if (!url.searchParams.has(key)) continue
        const value = url.searchParams.get(key)!
        if (!uuid.test(value)) return failure(400)
        params[mapped] = value
      }
      if (resource === 'rosters' && !params.targetMemberId) return failure(400)
      for (const key of ['query', 'position']) {
        if (!url.searchParams.has(key)) continue
        const value = url.searchParams.get(key)!
        if (value.length > 100 || /[\u0000-\u001f]/.test(value)) return failure(400)
        params[key] = value
      }
      const supported: Record<string, Resource[]> = {
        seasonYear: ['league', 'rosters', 'matchups', 'scores', 'schedule', 'draft-results', 'player-stats'],
        weekNumber: ['matchups', 'scores', 'schedule'],
        targetMemberId: ['rosters', 'matchups', 'scores', 'schedule', 'standings', 'transactions'],
        playerId: ['player-stats', 'projections'], query: ['player-stats', 'projections'], position: ['player-stats', 'projections'],
      }
      if (Object.entries(supported).some(([key, resources]) => params[key] !== undefined && !resources.includes(resource))) return failure(400)
      const scope = (await digest(JSON.stringify([token.toLowerCase(), resource, params]))).slice(0, 24)
      let offset = 0
      const cursor = url.searchParams.get('cursor')
      if (cursor) {
        if (cursor.length > 256) return failure(400)
        const decoded = JSON.parse(atob(cursor)) as { offset: number; scope: string }
        if (!decoded || typeof decoded !== 'object' || decoded.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset < 1 || decoded.offset > 1000000) return failure(400)
        offset = decoded.offset
      }
      params.offset = offset
      let result: Awaited<ReturnType<PublicRead>>
      try { result = await read(token.toLowerCase(), resource, params) } catch { return failure(503) }
      if (result.status !== 200) return failure(messages[result.status] ? result.status : 503,
        result.status === 429 ? { 'Retry-After': String(result.retryAfter ?? 60) } : {})
      if (!Array.isArray(result.items) || result.items.length > limit) return failure(503)
      const body = publicValue({ $schema: `urn:pancake:public:v1:${resource}`, version: 1, resource,
        items: result.items, nextCursor: result.hasMore ? btoa(JSON.stringify({ offset: offset + limit, scope })) : null }, publicContract.resources[resource])
      const text = JSON.stringify(body)
      const etag = `"${await digest(text)}"`
      const matches = (request.headers.get('if-none-match') ?? '').split(',').map(value => value.trim().replace(/^W\//, ''))
      if (matches.includes(etag) || matches.includes('*')) return new Response(null, { status: 304, headers: { ...headers, ETag: etag } })
      return new Response(text, { status: 200, headers: { ...headers, ETag: etag } })
    } catch (error) {
      return failure(error instanceof SyntaxError || (error instanceof Error && error.message === 'Invalid number') || error instanceof DOMException ? 400 : 503)
    }
  }
}
