import { authSession, inspectFixtureSession } from '../helpers/auth-session'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real AuthProvider, real supabase-js data client, real caches. Each database
// response is held until the test releases it, so a request started by one user
// can be made to land after a sign-out, an account switch, or a re-login.

const net = vi.hoisted(() => ({
    callback: null as null | ((event: string, session: unknown) => void),
    seeded: null as unknown,
    held: [] as { url: string; release: () => void }[],
    rows: {} as Record<string, unknown[]>,
}))

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}))
vi.mock('@/lib/supabase', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { fenceDataRequests } = await import('@/lib/session-fetch')
    const heldFetch = (input: RequestInfo | URL) => new Promise<Response>((resolve) => {
        const url = String(input instanceof Request ? input.url : input)
        const table = new URL(url).pathname.split('/').pop() ?? ''
        // The server answers with the rows as they were when the request was sent.
        const body = JSON.stringify(net.rows[table] ?? [])
        net.held.push({
            url,
            release: () => resolve(new Response(body, {
                status: 200, headers: { 'Content-Type': 'application/json' },
            })),
        })
    })
    const data = createClient('http://fence.test', 'anon-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: fenceDataRequests(heldFetch as typeof fetch) },
    })
    return {
        readStoredAuthState: () => inspectFixtureSession(net.seeded),
        inspectAuthSession: (value: unknown) => inspectFixtureSession(value),
        supabaseAuthStorageKey: 'sb-auth-fixture-auth-token',
        supabase: {
            auth: {
                getSession: () => new Promise(() => {}),
                onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
                    net.callback = callback
                    return { data: { subscription: { unsubscribe: vi.fn() } } }
                },
                startAutoRefresh: vi.fn(),
                stopAutoRefresh: vi.fn(),
            },
            from: (table: string) => data.from(table as never),
        },
    }
})

import { AuthProvider } from '@/hooks/use-auth'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { getCurrentSeason } from '@/lib/shared/season'
import { supabase } from '@/lib/supabase'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = authSession
const emit = async (event: string, value: unknown) => { await act(async () => { net.seeded = value; net.callback!(event, value) }) }
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const releaseAll = async () => {
    for (const request of net.held.splice(0)) request.release()
    await settle()
}

// The roster screen's shape: read, then cache what was read, with no ownership check.
async function cacheRoster(memberId: string) {
    const { data, error } = await supabase.from('roster_players').select('id').eq('member_id', memberId)
    if (error) throw new Error(error.message)
    writePersistentCache(`pancake:roster:${memberId}:league`, data)
}

describe('session generation fence', () => {
    let renderer: ReactTestRenderer

    beforeEach(async () => {
        net.seeded = session('user-a')
        net.held.length = 0
        net.rows = { roster_players: [{ id: 'roster-row' }], league_seasons: [{ id: 'season-a', season_year: 2026 }] }
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, null))
        })
        await emit('INITIAL_SESSION', session('user-a'))
    })

    afterEach(async () => {
        await releaseAll()
        await emit('SIGNED_OUT', null)
        act(() => renderer.unmount())
    })

    it('drops a response from user A that lands after a direct switch to user B', async () => {
        const read = cacheRoster('member-a').then(() => 'cached', (error: Error) => error.message)
        await settle()
        await emit('SIGNED_IN', session('user-b'))
        await releaseAll()

        expect(await read).toMatch(/signed-in user changed/)
        expect(readPersistentCache('pancake:roster:member-a:league')).toBeNull()
    })

    it('drops a response that lands after the same user signs out and back in', async () => {
        const read = cacheRoster('member-a').catch(() => undefined)
        await settle()
        await emit('SIGNED_OUT', null)
        await emit('SIGNED_IN', session('user-a'))
        await releaseAll()
        await read

        expect(readPersistentCache('pancake:roster:member-a:league')).toBeNull()
    })

    it('caches what user B reads after the switch', async () => {
        await emit('SIGNED_IN', session('user-b'))
        const read = cacheRoster('member-b')
        await settle()
        await releaseAll()
        await read

        expect(readPersistentCache('pancake:roster:member-b:league')).toEqual([{ id: 'roster-row' }])
    })

    it('keeps a response across a token refresh for the same user', async () => {
        const read = cacheRoster('member-a')
        await settle()
        await emit('TOKEN_REFRESHED', session('user-a'))
        await releaseAll()
        await read

        expect(readPersistentCache('pancake:roster:member-a:league')).toEqual([{ id: 'roster-row' }])
    })

    it('rejects user A\'s in-flight lookup after the switch and serves user B only its own', async () => {
        const forA = getCurrentSeason('league').catch(() => null)
        await settle()
        await emit('SIGNED_IN', session('user-b'))
        net.rows.league_seasons = [{ id: 'season-b', season_year: 2026 }]
        const forB = getCurrentSeason('league')
        await settle()
        expect(net.held).toHaveLength(2)
        await releaseAll()

        expect(await forA).toBeNull()
        expect(await forB).toEqual({ id: 'season-b', seasonYear: 2026 })
        expect(await getCurrentSeason('league')).toEqual({ id: 'season-b', seasonYear: 2026 })
        expect(net.held).toHaveLength(0)
    })

    it('forgets an in-memory lookup made while signed out once a user signs in', async () => {
        await emit('SIGNED_OUT', null)
        net.rows.league_seasons = []
        const whileSignedOut = getCurrentSeason('league')
        await settle()
        await releaseAll()
        expect(await whileSignedOut).toBeNull()

        await emit('SIGNED_IN', session('user-b'))
        net.rows.league_seasons = [{ id: 'season-b', season_year: 2026 }]
        const afterSignIn = getCurrentSeason('league')
        await settle()
        expect(net.held).toHaveLength(1)
        await releaseAll()
        expect(await afterSignIn).toEqual({ id: 'season-b', seasonYear: 2026 })
    })
})
