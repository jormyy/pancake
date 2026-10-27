import { afterEach, expect, it, vi } from 'vitest'
import { signInClient } from './e2e/seed-league.mjs'
import { signInSupabaseClient } from './e2e/soak-fixtures.mjs'

const boundary = vi.hoisted(() => ({ options: [] as { global: { fetch: typeof fetch } }[] }))
vi.mock('@supabase/supabase-js', () => ({ createClient: (_url: string, _key: string, options: { global: { fetch: typeof fetch } }) => {
    boundary.options.push(options)
    return { auth: { signInWithPassword: async () => ({ error: null }) } }
} }))
vi.mock('./e2e/env.mjs', () => ({ resolvedEnv: vi.fn(), requireEnv: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); boundary.options = [] })

it.each(['seed', 'soak'])('gives authenticated %s writes unique request IDs and retains them for retries', async source => {
    const calls: RequestInit[] = []
    const fetcher = vi.fn(async (_input: unknown, options?: RequestInit) => {
        calls.push(options ?? {})
        return new Response('{}', { status: calls.length === 1 ? 503 : 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const env = { supabaseUrl: 'http://127.0.0.1:59721', anonKey: 'synthetic-key' }
    if (source === 'seed') await signInClient(env, 'synthetic@example.com', 'synthetic-password')
    else await signInSupabaseClient(env, 'synthetic@example.com', 'synthetic-password', 'fixture')
    const wrapped = boundary.options[0].global.fetch
    const url = `${env.supabaseUrl}/rest/v1/rpc/create_league`
    await wrapped(url, { method: 'POST', body: '{}' })
    await wrapped(url, { method: 'POST', body: '{}' })
    expect(calls).toHaveLength(3)
    const ids = calls.map(call => new Headers(call.headers).get('x-request-id'))
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
})
