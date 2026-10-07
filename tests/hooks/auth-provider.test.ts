import { authSession, inspectFixtureSession } from '../helpers/auth-session'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from '@/hooks/use-auth'

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    authCallback: null as null | ((event: string, session: unknown) => void),
    unsubscribe: vi.fn(),
    readStoredSessionSync: vi.fn<() => unknown>(() => null),
    removeAppState: vi.fn(),
    clearPersistentCaches: vi.fn(),
    storageAvailable: true,
}))

vi.mock('react-native', () => ({
    AppState: {
        addEventListener: vi.fn(() => ({ remove: mocks.removeAppState })),
    },
}))
vi.mock('@/lib/supabase', () => ({
    readStoredAuthState: () => mocks.storageAvailable
        ? inspectFixtureSession(mocks.readStoredSessionSync())
        : { session: null, status: 'unavailable' },
    inspectAuthSession: (value: unknown) => inspectFixtureSession(value),
    supabaseAuthStorageKey: 'sb-auth-fixture-auth-token',
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
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: mocks.clearPersistentCaches }))

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
        mocks.readStoredSessionSync.mockReturnValue(null)
        mocks.storageAvailable = true
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
            mocks.readStoredSessionSync.mockReturnValue(authSession('user-new')); mocks.authCallback?.('SIGNED_IN', authSession('user-new'))
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

    it('seeds the stored session synchronously and keeps it when bootstrap rejects', async () => {
        mocks.readStoredSessionSync.mockReturnValue(authSession('user-seeded'))
        const bootstrap = deferred<{ data: { session: unknown }; error: null }>()
        mocks.getSession.mockReturnValue(bootstrap.promise)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)))
        })

        // First paint already has the persisted user — no loading gate.
        expect(snapshots[0]).toEqual({ userId: 'user-seeded', loading: false })

        // A transient bootstrap failure (offline boot) must not log the user out.
        await act(async () => {
            bootstrap.reject(new Error('network down'))
            await bootstrap.promise.catch(() => undefined)
        })
        expect(snapshots.at(-1)).toEqual({ userId: 'user-seeded', loading: false })
        mocks.readStoredSessionSync.mockReturnValue(null)
        await act(async () => { renderer.unmount() })
    })

    it('purges private caches on sign-out and cross-user transitions', async () => {
        mocks.readStoredSessionSync.mockReturnValue(authSession('user-a'))
        mocks.getSession.mockResolvedValue({
            data: { session: authSession('user-a') },
            error: null,
        })
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)))
            await Promise.resolve()
        })

        await act(async () => { mocks.authCallback?.('TOKEN_REFRESHED', authSession('user-a')) })
        expect(mocks.clearPersistentCaches).not.toHaveBeenCalled()
        await act(async () => { mocks.readStoredSessionSync.mockReturnValue(authSession('user-b')); mocks.authCallback?.('SIGNED_IN', authSession('user-b')) })
        expect(mocks.clearPersistentCaches).toHaveBeenCalledOnce()
        await act(async () => { mocks.authCallback?.('SIGNED_OUT', null) })
        expect(mocks.clearPersistentCaches).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })
    it('does not infer identity from an async session when storage is unavailable', async () => {
        mocks.storageAvailable = false
        mocks.readStoredSessionSync.mockReturnValue(authSession('user-a'))
        mocks.getSession.mockResolvedValue({ data: { session: authSession('user-a') }, error: null })
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)))
        })
        expect(snapshots.every((value) => value.userId === null)).toBe(true)
        await act(async () => { mocks.authCallback?.('SIGNED_IN', authSession('user-a')) })
        expect(snapshots.at(-1)).toEqual({ userId: null, loading: false })
        await act(async () => { renderer.unmount() })
    })
    it('expires an offline identity and rejects late expired auth events', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('navigator', { onLine: false })
        vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
        const stored = authSession('owner', Math.floor(Date.now() / 1000) + 2)
        mocks.readStoredSessionSync.mockReturnValue(stored)
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe))) })
            expect(snapshots.at(-1)?.userId).toBe('owner')
            await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
            expect(snapshots.at(-1)?.userId).toBe('owner')
            await act(async () => { await vi.advanceTimersByTimeAsync(1) })
            expect(snapshots.at(-1)).toEqual({ userId: null, loading: false })
            expect(mocks.clearPersistentCaches).toHaveBeenCalledOnce()
            await act(async () => { mocks.authCallback?.('INITIAL_SESSION', stored) })
            expect(snapshots.at(-1)?.userId).toBeNull()
            expect(mocks.getSession).not.toHaveBeenCalled()
        } finally {
            await act(async () => { renderer.unmount() })
            vi.unstubAllGlobals()
            vi.useRealTimers()
        }
    })

    it('rejects a valid but removed session from a late auth event after logout', async () => {
        const stored = authSession('owner')
        mocks.readStoredSessionSync.mockReturnValue(stored)
        mocks.getSession.mockReturnValue(new Promise(() => {}))
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe))) })
        await act(async () => {
            mocks.readStoredSessionSync.mockReturnValue(null)
            mocks.authCallback?.('SIGNED_OUT', null)
            mocks.authCallback?.('INITIAL_SESSION', stored)
        })
        expect(snapshots.at(-1)?.userId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

})
