import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    authCallback: null as null | ((event: string, session: unknown) => void),
    unsubscribe: vi.fn(),
    removeAppState: vi.fn(),
}))

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: vi.fn(() => ({ remove: mocks.removeAppState })),
    },
}))
vi.mock('@/lib/supabase', () => ({
    supabase: {
        auth: {
            getSession: mocks.getSession,
            onAuthStateChange: vi.fn((callback) => {
                mocks.authCallback = callback
                return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }
            }),
            startAutoRefresh: vi.fn(),
            stopAutoRefresh: vi.fn(),
        },
    },
}))

import { AuthProvider, useAuth } from '@/hooks/use-auth'

type Snapshot = { userId: string | null; loading: boolean }

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

describe('AuthProvider bootstrap ownership', () => {
    let snapshots: Snapshot[]

    beforeEach(() => {
        snapshots = []
        vi.clearAllMocks()
        mocks.authCallback = null
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    function Probe() {
        const { user, loading } = useAuth()
        snapshots.push({ userId: user?.id ?? null, loading })
        return null
    }

    it('does not let a late bootstrap overwrite a newer auth event', async () => {
        const bootstrap = deferred<{ data: { session: unknown }; error: null }>()
        mocks.getSession.mockReturnValue(bootstrap.promise)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)))
        })

        await act(async () => {
            mocks.authCallback?.('SIGNED_IN', { user: { id: 'user-new' } })
        })
        await act(async () => {
            bootstrap.resolve({ data: { session: null }, error: null })
            await bootstrap.promise
        })

        expect(snapshots.at(-1)).toEqual({ userId: 'user-new', loading: false })
        await act(async () => { renderer.unmount() })
    })

    it('settles loading when session restoration rejects', async () => {
        const bootstrap = deferred<{ data: { session: unknown }; error: null }>()
        mocks.getSession.mockReturnValue(bootstrap.promise)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)))
        })

        await act(async () => {
            bootstrap.reject(new Error('storage unavailable'))
            await bootstrap.promise.catch(() => undefined)
        })

        expect(snapshots.at(-1)).toEqual({ userId: null, loading: false })
        await act(async () => { renderer.unmount() })
    })
})
