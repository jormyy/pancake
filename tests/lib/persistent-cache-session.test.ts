import { authSession, inspectFixtureSession } from '../helpers/auth-session'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real AuthProvider and the real persistent cache: a request that
// was in flight when the user signed out must not re-save that user's data.

const auth = vi.hoisted(() => ({
    callback: null as null | ((event: string, session: unknown) => void),
    seeded: null as unknown,
    seasonReads: 0,
}))

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}))
vi.mock('@/lib/supabase', () => ({
    readStoredAuthState: () => inspectFixtureSession(auth.seeded),
        inspectAuthSession: (value: unknown) => inspectFixtureSession(value),
        supabaseAuthStorageKey: 'sb-auth-fixture-auth-token',
    supabase: {
        auth: {
            getSession: () => new Promise(() => {}),
            onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
                auth.callback = callback
                return { data: { subscription: { unsubscribe: vi.fn() } } }
            },
            startAutoRefresh: vi.fn(),
            stopAutoRefresh: vi.fn(),
        },
        from: () => {
            const query = {
                select: () => query,
                eq: () => query,
                maybeSingle: async () => {
                    auth.seasonReads += 1
                    return { data: { id: 'season', season_year: 2026 }, error: null }
                },
            }
            return query
        },
    },
}))

import { AuthProvider } from '@/hooks/use-auth'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { getCurrentSeason } from '@/lib/shared/season'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = authSession
const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

describe('persistent cache across sign-out', () => {
    let renderer: ReactTestRenderer

    beforeEach(async () => {
        auth.seeded = session('user-a')
        auth.seasonReads = 0
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, null))
        })
    })

    afterEach(() => {
        act(() => renderer.unmount())
    })

    it('drops a write from a request that resolves after sign-out', async () => {
        const response = deferred<string[]>()
        const lateWrite = response.promise.then((rows) => writePersistentCache('pancake:roster:member-a:league', rows))

        await act(async () => auth.callback!('SIGNED_OUT', null))
        response.resolve(['user a roster'])
        await lateWrite

        expect(readPersistentCache('pancake:roster:member-a:league')).toBeNull()
    })

    it('caches again once the next user signs in', async () => {
        await act(async () => auth.callback!('SIGNED_OUT', null))
        await act(async () => { auth.seeded = session('user-b'); auth.callback!('SIGNED_IN', session('user-b')) })

        writePersistentCache('pancake:roster:member-b:league', ['user b roster'])

        expect(readPersistentCache('pancake:roster:member-b:league')).toEqual(['user b roster'])
    })

    it('forgets in-memory league lookups at sign-out', async () => {
        await getCurrentSeason('league')
        await getCurrentSeason('league')
        expect(auth.seasonReads).toBe(1)

        await act(async () => auth.callback!('SIGNED_OUT', null))
        await act(async () => { auth.seeded = session('user-b'); auth.callback!('SIGNED_IN', session('user-b')) })
        await getCurrentSeason('league')

        expect(auth.seasonReads).toBe(2)
    })
})
