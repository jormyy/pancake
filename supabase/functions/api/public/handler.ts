import { definition, policy, publicContract, publicValue, READS_PER_MINUTE, resourceNames, type Resource } from './policy.ts'
import { renderFailure, renderPage, type LeagueContext } from './web.ts'
export { publicContract, resourceNames } from './policy.ts'

type Params = Record<string, unknown>
type Outcome = { status: number; retryAfter?: number }
export type PublicRead = (league: string | null, resource: Resource, params: Params, clientKey: string) => Promise<{
  status: number; items?: unknown[]; hasMore?: boolean; retryAfter?: number
}>
export type PublicAdmit = (clientKey: string) => Promise<Outcome>
export type PublicSource = { admit: PublicAdmit; read: PublicRead }
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, no-cache, max-age=0, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'if-none-match, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After',
  'X-Content-Type-Options': 'nosniff',
}
const webHeaders = { ...headers, 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const messages: Record<number, string> = { 400: 'Invalid request', 404: 'Public resource not found', 405: 'Read-only endpoint', 410: 'API version retired; use public v2', 429: 'Read limit reached', 503: 'Public data unavailable' }
const knownStatus = (status: number) => messages[status] ? status : 503
function retryHeader(outcome: Outcome): Record<string, string> {
  return outcome.status === 429 ? { 'Retry-After': String(Math.min(60, Math.max(1, Math.ceil(outcome.retryAfter ?? 60)))) } : {}
}
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
    const time = now(), current = Math.floor(time/60000)
    if (current !== minute) { clients.clear(); minute = current }
    const count = (clients.get(key) ?? 0)+1
    if (count > READS_PER_MINUTE) return Math.ceil(((current+1)*60000-time)/1000)
    if (!clients.has(key) && clients.size >= 4096) {
      const oldest = clients.keys().next().value
      if (oldest !== undefined) clients.delete(oldest)
    }
    clients.set(key,count)
    return 0
  }
}

type Query = { league: string | null; params: Params; limit: number; offset: number; scope: string }
type Page = { status: 200; items: unknown[]; nextCursor: string | null; text: string }

async function parse(url: URL, resource: Resource): Promise<Query | number> {
  const spec = definition(resource)
  const allowed = ['league','limit','cursor','sort','direction',...Object.keys(spec.filters)]
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return 400
  const league = url.searchParams.get('league')?.toLowerCase() ?? null
  if (resource !== 'leagues' && (!league || !uuid.test(league))) return 400
  if (resource === 'leagues' && league !== null) return 400
  const params: Params = {}
  const limitText = url.searchParams.get('limit') ?? String(policy.defaultLimit)
  if (!/^\d+$/.test(limitText)) return 400
  const limit = Number(limitText)
  if (!Number.isInteger(limit) || limit < 1 || limit > policy.maxLimit) return 400
  params.limit = limit
  for (const [key,value] of url.searchParams) {
    if (['league','limit','cursor'].includes(key)) continue
    if (['team','player','draft','trade'].includes(key)) {
      if (!uuid.test(value)) return 400
      params[key] = value.toLowerCase()
    } else if (key === 'season' || key === 'week') {
      if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>(key==='week'?60:2200)) return 400
      params[key] = Number(value)
    } else if (key === 'sort') {
      const field = spec.fields[value]
      if (!field || (Array.isArray(field.schema.type)?field.schema.type:[field.schema.type]).some(type=>['object','array'].includes(String(type)))) return 400
      params.sort = value
    } else if (key === 'direction') {
      if (!['asc','desc'].includes(value)) return 400
      params.direction = value
    } else {
      if (value.length>100 || /[\u0000-\u001f]/.test(value)) return 400
      params[key] = value
    }
  }
  if (resource === 'rosters' && !params.team) return 400
  const scope = (await digest(JSON.stringify([league,resource,Object.entries(params).sort()]))).slice(0,24)
  let offset = 0
  const cursor = url.searchParams.get('cursor')
  if (cursor) {
    if (cursor.length>256) return 400
    let decoded: { offset: number; scope: string }
    try { decoded = JSON.parse(atob(cursor)) } catch { return 400 }
    if (decoded?.scope !== scope || !Number.isSafeInteger(decoded.offset) || decoded.offset<1 || decoded.offset>policy.maxOffset) return 400
    offset = decoded.offset
  }
  return { league, params: { ...params, offset }, limit, offset, scope }
}

async function load(read: PublicRead, resource: Resource, query: Query, clientKey: string): Promise<Page | Outcome> {
  const { league, params, limit, offset, scope } = query
  let result: Awaited<ReturnType<PublicRead>>
  try { result = await read(league,resource,params,clientKey) } catch { return { status: 503 } }
  if (result.status!==200) return { status: knownStatus(result.status), retryAfter: result.retryAfter }
  if (!Array.isArray(result.items) || result.items.length>limit || typeof result.hasMore!=='boolean') return { status: 503 }
  if (resource !== 'leagues' && result.items.some(row => !row || typeof row !== 'object' || (row as Record<string,unknown>).leagueId !== league)) return { status: 503 }
  let items: unknown[]
  try { items=publicValue(result.items,publicContract.resources[resource].properties.items) as unknown[] } catch { return { status: 503 } }
  let count=items.length
  let page: Page
  do {
    const more=result.hasMore || count<items.length
    const nextOffset=offset+(count || limit)
    if (more && nextOffset>policy.maxOffset) return { status: 400 }
    const nextCursor = more ? btoa(JSON.stringify({offset:nextOffset,scope})) : null
    page = { status: 200, items: items.slice(0,count), nextCursor, text: JSON.stringify({ $schema: `urn:pancake:public:v2:${resource}`, version: 2, resource, items: items.slice(0,count), nextCursor }) }
    if (new TextEncoder().encode(page.text).byteLength<=policy.maxResponseBytes || count<=1) break
    count--
  } while (true)
  if (new TextEncoder().encode(page.text).byteLength>policy.maxResponseBytes) return { status: 503 }
  return page
}

async function leagueContext(read: PublicRead, resource: Resource, query: Query, clientKey: string): Promise<LeagueContext | Outcome> {
  if (resource === 'leagues') return { league: null }
  const season = query.params.season
  const params: Params = { limit: 1, offset: 0, ...(season === undefined ? {} : { season }) }
  const result = await load(read, 'league', { league: query.league, params, limit: 1, offset: 0, scope: '' }, clientKey)
  if (result.status !== 200) return result
  const row = (result as Page).items[0] as Record<string, unknown> | undefined
  if (!row) return { status: 404 }
  return { league: { id: String(row.id), name: String(row.name), seasonYear: typeof row.seasonYear === 'number' ? row.seasonYear : null } }
}

function apiBase(request: Request, url: URL, configured: string) {
  if (configured.startsWith('https://')) return `${configured.replace(/\/+$/, '')}/functions/v1/api`
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  const forwarded = request.headers.get('x-forwarded-host'), port = request.headers.get('x-forwarded-port')
  const host = !forwarded ? url.host : forwarded.includes(':') || !port || port === (proto === 'https' ? '443' : '80') ? forwarded : `${forwarded}:${port}`
  return `${proto}://${host}/functions/v1/api`
}

export function createPublicHandler(source: PublicSource, limit = createLimiter(), now = () => new Date(), projectUrl = '') {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (path === '/public/v1' || path.startsWith('/public/v1/')) return failure(410)
    const web = path === '/public/web' || path.startsWith('/public/web/')
    if (!web && path !== '/public/v2' && !path.startsWith('/public/v2/')) return null
    const url = new URL(request.url)
    const base = web ? apiBase(request, url, projectUrl) : ''
    const fail = (outcome: Outcome) => web
      ? new Response(renderFailure(outcome.status, base), { status: outcome.status, headers: { ...webHeaders, ...retryHeader(outcome) } })
      : failure(outcome.status, retryHeader(outcome))
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'GET') return web
      ? new Response(renderFailure(405, base), { status: 405, headers: { ...webHeaders, Allow: 'GET, OPTIONS' } })
      : failure(405, { Allow: 'GET, OPTIONS' })
    const clientKey = await digest(clientAddress(request))
    const wait = limit(clientKey)
    if (wait) return fail({ status: 429, retryAfter: wait })
    const name = web ? (path === '/public/web' ? 'leagues' : path.slice('/public/web/'.length)) : path.slice('/public/v2/'.length)
    if (!resourceNames.includes(name as Resource)) return fail({ status: 404 })
    const resource = name as Resource
    try {
      const query = await parse(url, resource)
      if (typeof query === 'number') return fail({ status: query })
      let admission: Outcome
      try { admission = await source.admit(clientKey) } catch { return fail({ status: 503 }) }
      if (admission.status !== 200) return fail({ status: knownStatus(admission.status), retryAfter: admission.retryAfter })
      const page = await load(source.read, resource, query, clientKey)
      if (page.status !== 200) return fail(page)
      const { text, items, nextCursor } = page as Page
      if (web) {
        const context = await leagueContext(source.read, resource, query, clientKey)
        if ('status' in context) return fail(context)
        return new Response(renderPage({ base, resource, url, items: items as Record<string, unknown>[], nextCursor, readAt: now(), index: path === '/public/web', league: context.league }), { status: 200, headers: webHeaders })
      }
      const etag = `"${await digest(text)}"`
      const matches = (request.headers.get('if-none-match') ?? '').split(',').map(value => value.trim().replace(/^W\//,''))
      if (matches.includes(etag) || matches.includes('*')) return new Response(null,{status:304,headers:{...headers,ETag:etag}})
      return new Response(text,{status:200,headers:{...headers,ETag:etag}})
    } catch {
      return fail({ status: 503 })
    }
  }
}
