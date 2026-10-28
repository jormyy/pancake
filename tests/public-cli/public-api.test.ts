import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createPublicHandler } from '../../supabase/functions/api/public/handler'
import { publicContract, publicValue, resourceNames, type Resource } from '../../supabase/functions/api/public/handler'

const token = 'a'.repeat(64)
const team = '11111111-1111-4111-8111-111111111111'
const privateValue = 'PRIVATE_SENTINEL@example.invalid'
const hidden = { email: privateValue, user_id: privateValue, userId: privateValue, invite_code: privateValue,
  pendingTrades: [privateValue], offers: [privateValue], faabBid: privateValue, assignments: { player: privateValue }, privateNotes: privateValue }
function sample(schema: Record<string, unknown>): unknown {
  if ('const' in schema) return schema.const
  if ('enum' in schema) return (schema.enum as unknown[])[0]
  if (schema.properties) return Object.fromEntries(Object.entries(schema.properties as Record<string, Record<string, unknown>>).map(([key, value]) => [key, sample(value)]))
  if (schema.items) return [sample(schema.items as Record<string, unknown>)]
  const types = schema.type as string[] | string
  const type = Array.isArray(types) ? types[0] : types
  return type === 'string' ? 'public value' : type === 'boolean' ? false : 1
}
function poison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(poison)
  if (value && typeof value === 'object') return { ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, poison(child)])), ...hidden }
  return value
}
function request(resource: string, init: RequestInit = {}, query = '') {
  return new Request(`http://127.0.0.1/public/v1/${resource}${query}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
}
async function handle(resource: Resource, data: unknown) {
  const route = createPublicHandler(async () => ({ status: 200, items: [data] }))
  const query = resource === 'rosters' ? `?team=${team}` : ''
  return route(request(resource, {}, query), `/public/v1/${resource}`)
}
describe('public API boundary', () => {
  it.each(resourceNames)('copies only approved fields for %s', async resource => {
    const shape = publicContract.resources[resource].properties.items.items
    const item = sample(shape)
    const response = (await handle(resource, poison(item)))!
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toEqual([item])
    expect(JSON.stringify(body)).not.toContain(privateValue)
    for (const field of Object.keys(hidden)) expect(JSON.stringify(body)).not.toContain(`"${field}"`)
  })
  it.each(['trade_offered', 'trade_accepted', 'trade_pending', 'waiver_bid', 'private_note'])('rejects private transaction type %s', async type => {
    const item = sample(publicContract.resources.transactions.properties.items.items) as Record<string, unknown>
    expect((await handle('transactions', { ...item, type }))!.status).toBe(503)
  })
  it('requires a token without making a database call', async () => {
    const read = vi.fn()
    const route = createPublicHandler(read)
    for (const authorization of ['', 'Bearer bad', `Basic ${token}`]) {
      expect((await route(new Request('http://localhost/public/v1/league', { headers: { authorization } }), '/public/v1/league'))!.status).toBe(401)
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('rejects writes and handles public preflight', async () => {
    const read = vi.fn()
    const route = createPublicHandler(read)
    expect((await route(request('league', { method: 'POST' }), '/public/v1/league'))!.status).toBe(405)
    const preflight = (await route(request('league', { method: 'OPTIONS' }), '/public/v1/league'))!
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('if-none-match')
    expect(read).not.toHaveBeenCalled()
  })
  it('rechecks token validity before honoring an ETag', async () => {
    const item = sample(publicContract.resources.league.properties.items.items)
    const read = vi.fn().mockResolvedValueOnce({ status: 200, items: [item] }).mockResolvedValueOnce({ status: 200, items: [item] }).mockResolvedValueOnce({ status: 401 })
    const route = createPublicHandler(read)
    const first = (await route(request('league'), '/public/v1/league'))!
    const etag = first.headers.get('etag')!
    const second = (await route(request('league', { headers: { 'If-None-Match': `W/${etag}` } }), '/public/v1/league'))!
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    expect((await route(request('league', { headers: { 'If-None-Match': etag } }), '/public/v1/league'))!.status).toBe(401)
    expect(read).toHaveBeenCalledTimes(3)
    expect(first.headers.get('cache-control')).toContain('must-revalidate')
  })
  it('returns the rate limit without leaking database errors', async () => {
    const limited = createPublicHandler(async () => ({ status: 429, retryAfter: 17 }))
    const response = (await limited(request('league'), '/public/v1/league'))!
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    const failed = createPublicHandler(async () => { throw new Error(privateValue) })
    expect(await (await failed(request('league'), '/public/v1/league'))!.text()).not.toContain(privateValue)
  })
  it.each(['?token=secret', '?params={}', '?limit=51', '?limit=0', '?limit=2&limit=3', '?team=bad', '?cursor=bad', '?cursor=bnVsbA%3D%3D', '?week=3'])('rejects invalid parameters %s', async query => {
    const read = vi.fn()
    const route = createPublicHandler(read)
    expect((await route(request('league', {}, query), '/public/v1/league'))!.status).toBe(400)
    expect(read).not.toHaveBeenCalled()
  })
  it('ties cursors to the token, resource and filters', async () => {
    const read = vi.fn(async () => ({ status: 200, items: [], hasMore: true }))
    const route = createPublicHandler(read)
    const first = (await route(request('standings', {}, '?limit=1'), '/public/v1/standings'))!
    const cursor = (await first.json()).nextCursor
    expect((await route(request('standings', {}, `?limit=1&cursor=${encodeURIComponent(cursor)}`), '/public/v1/standings'))!.status).toBe(200)
    expect(read.mock.calls).toHaveLength(2)
    expect((await route(request('scores', {}, `?limit=1&cursor=${encodeURIComponent(cursor)}`), '/public/v1/scores'))!.status).toBe(400)
    expect((await route(request('standings', {}, `?limit=2&cursor=${encodeURIComponent(cursor)}`), '/public/v1/standings'))!.status).toBe(400)
  })
  it('returns null outside the public family', async () => {
    expect(await createPublicHandler(vi.fn())(request('league'), '/health')).toBeNull()
  })
})
it('freezes the versioned schemas and keeps the npm copy identical', () => {
  expect(publicContract).toMatchSnapshot()
  expect(JSON.parse(readFileSync('packages/pancake-cli/schemas/v1.json', 'utf8'))).toEqual(publicContract)
  expect(() => publicValue({ type: 'pending' }, publicContract.resources.transactions.properties.items.items)).toThrow()
})
