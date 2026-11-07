import { definition, policy, publicContract, publicValue, resourceNames, type Resource } from './policy.ts'
export { publicContract, resourceNames } from './policy.ts'

export type PublicRead = (league: string | null, resource: Resource, params: Record<string, unknown>, clientKey: string) => Promise<{
  status: number; items?: unknown[]; hasMore?: boolean; retryAfter?: number
}>
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, no-cache, max-age=0, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'if-none-match, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After',
  'X-Content-Type-Options': 'nosniff',
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const messages: Record<number, string> = { 400: 'Invalid request', 404: 'Public resource not found', 405: 'Read-only endpoint', 410: 'API version retired; use public v2', 429: 'Read limit reached', 503: 'Public data unavailable' }
function failure(status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ $schema: 'urn:pancake:public:v2:error', version: 2, error: { code: status, message: messages[status] ?? messages[503] } }), { status, headers: { ...headers, 'Cache-Control': 'no-store', ...extra } })
}
async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
function clientAddress(request: Request): string {
  const value = request.headers.get('cf-connecting-ip')?.trim()
  if (!value) return 'unattributed'
  if (/^[0-9.]+$/.test(value)) {
    const octets = value.split('.')
    if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return octets.map(Number).join('.')
    return 'unattributed'
  }
  if (!/^[a-f0-9:.]+$/i.test(value)) return 'unattributed'
  try { return new URL(`http://[${value}]/`).hostname } catch { return 'unattributed' }
}
export function createLimiter(now = Date.now) {
  let minute = -1
  const clients = new Map<string, number>()
  return (key: string) => {
    const current = Math.floor(now()/60000)
    if (current !== minute) { clients.clear(); minute = current }
    const count = (clients.get(key) ?? 0)+1
    if (count > 60) return false
    if (!clients.has(key) && clients.size >= 4096) {
      const oldest = clients.keys().next().value
      if (oldest !== undefined) clients.delete(oldest)
    }
    clients.set(key,count)
    return true
  }
}
export function createPublicHandler(read: PublicRead, admit = createLimiter()) {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (path === '/public/v1' || path.startsWith('/public/v1/')) return failure(410)
    if (path !== '/public/v2' && !path.startsWith('/public/v2/')) return null
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'GET') return failure(405, { Allow: 'GET, OPTIONS' })
    const clientKey = await digest(clientAddress(request))
    if (!admit(clientKey)) return failure(429, { 'Retry-After': '60' })
    const name = path.slice('/public/v2/'.length)
    if (!resourceNames.includes(name as Resource)) return failure(404)
    const resource = name as Resource, spec = definition(resource)
    try {
      const url = new URL(request.url)
      const allowed = ['league','limit','cursor','sort','direction',...Object.keys(spec.filters)]
      for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return failure(400)
      const league = url.searchParams.get('league')?.toLowerCase() ?? null
      if (resource !== 'leagues' && (!league || !uuid.test(league))) return failure(400)
      if (resource === 'leagues' && league !== null) return failure(400)
      const params: Record<string, unknown> = {}
      const limitText = url.searchParams.get('limit') ?? String(policy.defaultLimit)
      if (!/^\d+$/.test(limitText)) return failure(400)
      const limit = Number(limitText)
      if (!Number.isInteger(limit) || limit < 1 || limit > policy.maxLimit) return failure(400)
      params.limit = limit
      for (const [key,value] of url.searchParams) {
        if (['league','limit','cursor'].includes(key)) continue
        if (['team','player','draft','trade'].includes(key)) {
          if (!uuid.test(value)) return failure(400)
          params[key] = value.toLowerCase()
        } else if (key === 'season' || key === 'week') {
          if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>(key==='week'?60:2200)) return failure(400)
          params[key] = Number(value)
        } else if (key === 'sort') {
          const field = spec.fields[value]
          if (!field || (Array.isArray(field.schema.type)?field.schema.type:[field.schema.type]).some(type=>['object','array'].includes(String(type)))) return failure(400)
          params.sort = value
        } else if (key === 'direction') {
          if (!['asc','desc'].includes(value)) return failure(400)
          params.direction = value
        } else {
          if (value.length>100 || /[\u0000-\u001f]/.test(value)) return failure(400)
          params[key] = value
        }
      }
      if (resource === 'rosters' && !params.team) return failure(400)
      const scope = (await digest(JSON.stringify([league,resource,Object.entries(params).sort()]))).slice(0,24)
      let offset = 0
      const cursor = url.searchParams.get('cursor')
      if (cursor) {
        if (cursor.length>256) return failure(400)
        const decoded = JSON.parse(atob(cursor)) as { offset: number; scope: string }
        if (decoded?.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset<1 || decoded.offset>policy.maxOffset) return failure(400)
        offset = decoded.offset
      }
      params.offset = offset
      let result: Awaited<ReturnType<PublicRead>>
      try { result = await read(league,resource,params,clientKey) } catch { return failure(503) }
      if (result.status!==200) return failure(messages[result.status] ? result.status : 503,
        result.status===429 ? { 'Retry-After': String(Math.min(60,Math.max(1,result.retryAfter ?? 60))) } : {})
      if (!Array.isArray(result.items) || result.items.length>limit || typeof result.hasMore!=='boolean') return failure(503)
      if (resource !== 'leagues' && result.items.some(row => !row || typeof row !== 'object' || (row as Record<string,unknown>).leagueId !== league)) return failure(503)
      if (result.hasMore && offset+limit>policy.maxOffset) return failure(400)
      const body = publicValue({ $schema: `urn:pancake:public:v2:${resource}`, version: 2, resource, items: result.items,
        nextCursor: result.hasMore ? btoa(JSON.stringify({offset:offset+limit,scope})) : null },publicContract.resources[resource])
      const text = JSON.stringify(body)
      if (new TextEncoder().encode(text).byteLength>policy.maxResponseBytes) return failure(503)
      const etag = `"${await digest(text)}"`
      const matches = (request.headers.get('if-none-match') ?? '').split(',').map(value => value.trim().replace(/^W\//,''))
      if (matches.includes(etag) || matches.includes('*')) return new Response(null,{status:304,headers:{...headers,ETag:etag}})
      return new Response(text,{status:200,headers:{...headers,ETag:etag}})
    } catch (error) {
      return failure(error instanceof SyntaxError || error instanceof DOMException ? 400 : 503)
    }
  }
}
