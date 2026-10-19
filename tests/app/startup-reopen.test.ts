/// <reference path="../../types/react-dom.d.ts" />
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError } from '@supabase/supabase-js'
import { authSession, fixtureProject } from '../helpers/auth-session'
import { authStorageKey, inspectSession, readStoredAuth } from '@/lib/auth-session'
import { clearPersistentCaches, readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { setSessionOwner, sessionGeneration } from '@/lib/session-cache-registry'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { useBootShellHandoff } from '@/hooks/use-boot-shell-handoff'
import RootLayout from '@/app/_layout'
import SignInScreen from '@/app/(auth)/sign-in'
import type { LeagueMembership } from '@/types/app'

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(), fetchUserLeagues: vi.fn(), replace: vi.fn(),
    route: '/' as string,
    callback: null as null | ((event: string, session: unknown) => void),
    shellRemoved: vi.fn(),
}))

vi.mock('react-native-reanimated', () => ({}))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'view', Text: 'text',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@react-navigation/native', () => ({ DefaultTheme: { colors: {} }, ThemeProvider: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@expo-google-fonts/outfit', () => ({ useFonts: () => [], Outfit_500Medium: {}, Outfit_600SemiBold: {}, Outfit_700Bold: {} }))
vi.mock('expo-font', () => ({ useFonts: () => [], FontDisplay: { SWAP: 'swap' } }))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: mocks.replace }),
    useSegments: () => mocks.route === '/sign-in' ? ['(auth)'] : ['(tabs)'],
    Link: 'link',
    Stack: Object.assign(() => React.createElement(RouteProbe), { Screen: () => null }),
}))
vi.mock('@/hooks/use-web-push-notifications', () => ({ useWebPushNotifications: () => {} }))
vi.mock('@/components/ui', () => ({
    FeedbackProvider: ({ children }: React.PropsWithChildren) => children,
    Button: 'button', Input: 'input',
}))
vi.mock('@/components/auth/AuthScaffold', () => ({ AuthScaffold: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/LeagueAccessNotice', () => ({ LeagueAccessNotice: () => null }))
vi.mock('@/components/navigation/WebTabShell', () => ({
    WebAppShell: ({ children }: React.PropsWithChildren) => { useBootShellHandoff(); return children },
}))
vi.mock('@/lib/auth', () => ({ signIn: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
    readStoredAuthState: () => readStoredAuth(window.localStorage, fixtureProject),
    inspectAuthSession: (value: unknown) => inspectSession(value, fixtureProject),
    supabaseAuthStorageKey: authStorageKey(fixtureProject), localAuthChangeEvent: 'pancake-local-auth-change',
    supabase: { auth: {
        getSession: mocks.getSession,
        onAuthStateChange: (callback: typeof mocks.callback) => {
            mocks.callback = callback
            return { data: { subscription: { unsubscribe: vi.fn() } } }
        },
        startAutoRefresh: vi.fn(), stopAutoRefresh: vi.fn(),
    } },
}))
vi.mock('@/lib/league', () => ({ fetchUserLeagues: mocks.fetchUserLeagues }))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: () => ({}), unsubscribeFromTableChanges: () => {}, reportRealtimeCleanup: () => {},
}))

const day = 24 * 60 * 60 * 1000
const selectionKey = (owner = 'owner') => `pancake:selected-league:v1:${owner}`
const membershipKey = (owner = 'owner') => `pancake:league-memberships:v1:${owner}`
const membership = (id: string): LeagueMembership => ({
    id, role: 'manager', team_name: id,
    leagues: { id: `league-${id}`, name: id, invite_code: null, status: 'active', commissioner_id: 'commissioner',
        auction_budget: 200, scoring_settings: {}, playoff_start_week: 20, roster_size: 20, ir_slots: 2 },
})
const first = membership('first'), selected = membership('selected')
const pending = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}
let snapshots: { route: string; loading: boolean; user: string | null; league: string | null; status: string }[]
let renderer: ReactTestRenderer | undefined

function RouteProbe() {
    const { user, loading, restorationStatus } = useAuth()
    const { current } = useLeagueContext()
    snapshots.push({ route: mocks.route, loading, user: user?.id ?? null, league: current?.id ?? null, status: restorationStatus })
    // Render the real notice even on a stored auth route during restoration.
    return React.createElement(SignInScreen)
}

function seedSession(owner = 'owner', expired = false) {
    const value = authSession(owner, Math.floor(Date.now() / 1000) + (expired ? -60 : 3600))
    window.localStorage.setItem(authStorageKey(fixtureProject), JSON.stringify(value))
    return value
}
function seedCache(key: string, value: unknown, age = 0) {
    window.localStorage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now() - age, value }))
}
async function mount() {
    await act(async () => { renderer = create(React.createElement(RootLayout)) })
}
function notice() { return JSON.stringify(renderer?.toJSON()).includes('Your session expired') }

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    const entries = new Map<string, string>()
    const localStorage = {
        get length() { return entries.size }, key: (index: number) => [...entries.keys()][index] ?? null,
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value) },
        removeItem: (key: string) => { entries.delete(key) }, clear: () => entries.clear(),
    }
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage }))
    vi.stubGlobal('document', Object.assign(new EventTarget(), {
        visibilityState: 'visible', getElementById: () => ({ remove: mocks.shellRemoved }),
        documentElement: { removeAttribute: vi.fn() },
    }))
    vi.stubGlobal('navigator', { onLine: true })
    setSessionOwner(null)
    clearPersistentCaches()
    mocks.route = '/'
    mocks.getSession.mockReturnValue(new Promise(() => {}))
    mocks.fetchUserLeagues.mockReturnValue(new Promise(() => {}))
    snapshots = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = undefined
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('installed PWA restoration', () => {
    it('waits for an expired token refresh, then lands on the saved league without sign-in or an expired notice', async () => {
        seedSession('owner', true)
        seedCache(selectionKey(), selected.id, 7 * day)
        seedCache(membershipKey(), [first, selected], 7 * day)
        const refresh = pending<{ data: { session: unknown }; error: null }>()
        mocks.getSession.mockReturnValue(refresh.promise)
        await mount()
        expect(mocks.replace).not.toHaveBeenCalled()
        expect(snapshots.at(-1)?.loading).toBe(true)
        expect(notice()).toBe(false)
        expect(mocks.fetchUserLeagues).not.toHaveBeenCalled()
        expect(mocks.shellRemoved).not.toHaveBeenCalled()
        await act(async () => { refresh.resolve({ data: { session: seedSession() }, error: null }) })
        expect(snapshots.at(-1)?.league).toBe(selected.id)
        expect(snapshots.every((value) => value.route !== '/sign-in' && value.league !== first.id)).toBe(true)
        expect(mocks.replace).not.toHaveBeenCalled()
        expect(notice()).toBe(false)
        expect(mocks.shellRemoved).toHaveBeenCalled()
    })

    it('shows the expired notice when the refresh is rejected and the SDK removes its session', async () => {
        seedSession('owner', true)
        seedCache(selectionKey(), selected.id)
        const refresh = pending<{ data: { session: null }; error: AuthApiError }>()
        mocks.getSession.mockReturnValue(refresh.promise)
        await mount()
        expect(mocks.replace).not.toHaveBeenCalled()
        await act(async () => {
            window.localStorage.removeItem(authStorageKey(fixtureProject))
            mocks.callback?.('SIGNED_OUT', null)
            refresh.resolve({ data: { session: null }, error: new AuthApiError('Refresh rejected', 400, 'refresh_token_not_found') })
        })
        expect(mocks.replace).toHaveBeenCalledWith('/sign-in')
        expect(notice()).toBe(true)
        expect(readPersistentCache(selectionKey())).toBeNull()
    })

    it('settles an offline expired session without trusting its access token', async () => {
        vi.stubGlobal('navigator', { onLine: false })
        seedSession('owner', true)
        seedCache(selectionKey(), selected.id)
        await mount()
        expect(mocks.replace).toHaveBeenCalledWith('/sign-in')
        expect(notice()).toBe(true)
        expect(mocks.getSession).not.toHaveBeenCalled()
        expect(mocks.fetchUserLeagues).not.toHaveBeenCalled()
        expect(snapshots.every((value) => value.user === null)).toBe(true)
        expect(readPersistentCache(selectionKey())).toBeNull()
    })

    it('retains the pending restoration on a transient refresh failure and retries on reconnect', async () => {
        seedSession('owner', true)
        seedCache(selectionKey(), selected.id)
        seedCache(membershipKey(), [first, selected])
        mocks.getSession.mockResolvedValueOnce({ data: { session: null }, error: new Error('Network down') })
        await mount()
        expect(mocks.replace).not.toHaveBeenCalled()
        expect(notice()).toBe(false)
        expect(snapshots.at(-1)?.loading).toBe(true)
        mocks.getSession.mockImplementationOnce(async () => ({ data: { session: seedSession() }, error: null }))
        await act(async () => { window.dispatchEvent(new Event('online')) })
        expect(snapshots.at(-1)?.league).toBe(selected.id)
    })

    it('defers hidden restoration until visible without showing sign-in', async () => {
        seedSession('owner', true)
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        await mount()
        expect(mocks.replace).not.toHaveBeenCalled()
        expect(mocks.getSession).not.toHaveBeenCalled()
        Object.defineProperty(document, 'visibilityState', { value: 'visible' })
        mocks.getSession.mockImplementationOnce(async () => ({ data: { session: seedSession() }, error: null }))
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(snapshots.at(-1)?.user).toBe('owner')
    })

    it('clears selection and cached rows on account switch and sign-out, and rejects late auth and membership results', async () => {
        const old = seedSession()
        seedCache(selectionKey(), selected.id)
        seedCache(membershipKey(), [first, selected])
        const rows = pending<LeagueMembership[]>()
        mocks.fetchUserLeagues.mockReturnValueOnce(rows.promise)
        await mount()
        expect(snapshots.at(-1)?.league).toBe(selected.id)
        await act(async () => { mocks.callback?.('SIGNED_IN', seedSession('other')) })
        expect(readPersistentCache(selectionKey())).toBeNull()
        expect(readPersistentCache(membershipKey())).toBeNull()
        expect(snapshots.at(-1)?.league).toBeNull()
        await act(async () => { rows.resolve([first, selected]); mocks.callback?.('INITIAL_SESSION', old) })
        expect(snapshots.at(-1)?.user).toBe('other')
        expect(snapshots.at(-1)?.league).toBeNull()
        writePersistentCache(selectionKey('other'), 'other-member')
        await act(async () => { window.localStorage.removeItem(authStorageKey(fixtureProject)); mocks.callback?.('SIGNED_OUT', null) })
        expect(readPersistentCache(selectionKey('other'))).toBeNull()
        expect(snapshots.at(-1)?.user).toBeNull()
    })

    it('keeps a selected league through a valid online session expiry and fences old data requests', async () => {
        seedSession()
        seedCache(selectionKey(), selected.id)
        seedCache(membershipKey(), [first, selected])
        await mount()
        const generation = sessionGeneration()
        await act(async () => { await vi.advanceTimersByTimeAsync(3600_000) })
        expect(snapshots.at(-1)?.user).toBeNull()
        expect(snapshots.at(-1)?.loading).toBe(true)
        expect(sessionGeneration()).toBeGreaterThan(generation)
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
        expect(mocks.replace).not.toHaveBeenCalled()
    })

    it('restores the latest expired owner after a resume supersedes an in-flight refresh', async () => {
        const old = seedSession('owner', true)
        seedCache(selectionKey(), selected.id)
        const refresh = pending<{ data: { session: unknown }; error: null }>()
        mocks.getSession.mockReturnValueOnce(refresh.promise)
        await mount()
        mocks.getSession.mockImplementationOnce(async () => ({ data: { session: seedSession('other') }, error: null }))
        await act(async () => {
            seedSession('other', true)
            window.dispatchEvent(new Event('pancake-local-auth-change'))
            mocks.callback?.('INITIAL_SESSION', null)
        })
        expect(mocks.replace).not.toHaveBeenCalled()
        expect(readPersistentCache(selectionKey())).toBeNull()
        await act(async () => { refresh.resolve({ data: { session: old }, error: null }) })
        expect(snapshots.at(-1)?.user).toBe('other')
        expect(mocks.getSession).toHaveBeenCalledTimes(2)
    })

    it('retains an expired notice when startup returns no session after removing rejected auth', async () => {
        seedSession('owner', true)
        const refresh = pending<{ data: { session: null }; error: null }>()
        mocks.getSession.mockReturnValue(refresh.promise)
        await mount()
        await act(async () => {
            window.localStorage.removeItem(authStorageKey(fixtureProject))
            refresh.resolve({ data: { session: null }, error: null })
        })
        expect(mocks.replace).toHaveBeenCalledWith('/sign-in')
        expect(notice()).toBe(true)
    })

    it('does not admit a session without a refresh token or with a mismatched token subject', async () => {
        for (const value of [
            { ...authSession('owner'), refresh_token: '' },
            { ...authSession('owner'), user: { id: 'other', aud: 'authenticated' } },
        ]) {
            window.localStorage.setItem(authStorageKey(fixtureProject), JSON.stringify(value))
            await mount()
            expect(snapshots.at(-1)?.user).toBeNull()
            expect(snapshots.at(-1)?.status).toBe('invalid')
            expect(mocks.replace).toHaveBeenCalledWith('/sign-in')
            await act(async () => { renderer?.unmount() })
        }
    })

    it('does not replace a saved choice using a stale list that omits it', async () => {
        seedSession()
        seedCache(selectionKey(), selected.id)
        seedCache(membershipKey(), [first])
        const rows = pending<LeagueMembership[]>()
        mocks.fetchUserLeagues.mockReturnValue(rows.promise)
        await mount()
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
        expect(snapshots.at(-1)?.league).toBeNull()
        await act(async () => { rows.resolve([first, selected]) })
        expect(snapshots.at(-1)?.league).toBe(selected.id)
        expect(snapshots.every((value) => value.league !== first.id)).toBe(true)
    })

    it('shows week-old memberships while revalidating and falls back safely when the selected membership is removed', async () => {
        seedSession()
        seedCache(selectionKey(), selected.id, 7 * day)
        seedCache(membershipKey(), [first, selected], 7 * day)
        const rows = pending<LeagueMembership[]>()
        mocks.fetchUserLeagues.mockReturnValue(rows.promise)
        await mount()
        expect(snapshots.at(-1)?.league).toBe(selected.id)
        await act(async () => { rows.resolve([first]) })
        expect(snapshots.at(-1)?.league).toBe(first.id)
        expect(readPersistentCache(selectionKey())).toBe(first.id)
        expect(readPersistentCache(membershipKey())).toEqual([first])
    })
})

describe('startup cache durability', () => {
    it('keeps the league choice without an age limit and keeps memberships for thirty days', () => {
        setSessionOwner('owner')
        writePersistentCache(selectionKey(), selected.id)
        writePersistentCache(membershipKey(), [first, selected])
        vi.setSystemTime(Date.now() + 7 * day)
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
        expect(readPersistentCache(membershipKey())).toEqual([first, selected])
        vi.setSystemTime(Date.now() + 24 * day)
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
        expect(readPersistentCache(membershipKey())).toBeNull()
        vi.setSystemTime(Date.now() + 365 * day)
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
    })

    it('protects startup entries from global and player-search pruning', () => {
        setSessionOwner('owner')
        writePersistentCache(selectionKey(), selected.id)
        writePersistentCache(membershipKey(), [first, selected])
        vi.setSystemTime(Date.now() + 1000)
        for (let index = 0; index < 80; index++) writePersistentCache(`pancake:test:${index}`, index)
        for (let index = 0; index < 20; index++) writePersistentCache(`pancake:player-search:${index}`, index)
        expect(readPersistentCache(selectionKey())).toBe(selected.id)
        expect(readPersistentCache(membershipKey())).toEqual([first, selected])
        expect(readPersistentCache('pancake:test:0')).toBeNull()
        expect(readPersistentCache('pancake:player-search:0')).toBeNull()
        expect(readPersistentCache('pancake:player-search:19')).toBe(19)
    })
})
