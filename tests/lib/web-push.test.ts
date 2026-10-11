import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    apiPost: vi.fn(), sessionOwner: vi.fn(), sessionGeneration: vi.fn(),
    captureWebPushIntent: vi.fn(), admitWebPushIntent: vi.fn(), closeWebPushIntent: vi.fn(),
    assertWebPushIntent: vi.fn(), readWebPushAuthority: vi.fn(), saveWebPushAuthority: vi.fn(), retireWebPushEndpoint: vi.fn(),
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: mocks.sessionOwner, sessionGeneration: mocks.sessionGeneration }))
vi.mock('@/lib/web-push-state', () => mocks)
import type { WebPushAuthority, WebPushIntent } from '@/lib/web-push-state'
let intent: WebPushIntent
const authorities = new Map<string, WebPushAuthority>()

const PUBLIC_KEY = 'BPcMbnWQL5GOYX_5LKZXT6sLmHiMsJSiEvIFvfcDvX7IZ9qqtq68onpTPEYmyxSQNiH7UD_98AUcQ12kBoxz_0s'
const OTHER_KEY_BYTES = new Uint8Array(65).fill(7).buffer

type FakeSubscription = {
    endpoint: string
    options: { applicationServerKey: ArrayBuffer | null }
    toJSON: () => { keys: { p256dh: string; auth: string } }
    unsubscribe: ReturnType<typeof vi.fn>
}

function fakeSubscription(endpoint: string, key: ArrayBuffer | null): FakeSubscription {
    return {
        endpoint,
        options: { applicationServerKey: key },
        toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
        unsubscribe: vi.fn(async () => true),
    }
}

function keyBytes(): ArrayBuffer {
    const normalized = PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer
}

let current: FakeSubscription | null
let permission: NotificationPermission
const calls: string[] = []
const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
        calls.push('subscribe')
        current = fakeSubscription('https://web.push.apple.com/new', keyBytes())
        return current
    }),
}

function installBrowser({ push = true, userAgent = 'Mozilla/5.0 (Macintosh)' } = {}) {
    const registration = { pushManager }
    vi.stubGlobal('navigator', {
        userAgent,
        platform: 'MacIntel',
        maxTouchPoints: 0,
        serviceWorker: {
            getRegistration: vi.fn(async () => registration),
            ready: Promise.resolve(registration),
        },
    })
    vi.stubGlobal('window', {
        ...(push ? { PushManager: class {}, Notification: class {} } : {}),
        matchMedia: () => ({ matches: false }),
    })
    vi.stubGlobal('Notification', {
        get permission() { return permission },
        requestPermission: vi.fn(async () => {
            calls.push('requestPermission')
            permission = 'granted'
            return permission
        }),
    })
}

async function load() {
    vi.resetModules()
    return import('@/lib/web-push')
}

beforeEach(() => {
    vi.clearAllMocks()
    calls.length = 0
    authorities.clear()
    intent = { revision: 'initial-test', ownerId: 'owner-a', allowed: true, pushEnabled: true, reason: 'active' }
    mocks.sessionOwner.mockReturnValue('owner-a')
    mocks.sessionGeneration.mockReturnValue(1)
    mocks.captureWebPushIntent.mockImplementation(async () => ({ ...intent }))
    mocks.admitWebPushIntent.mockImplementation(async (previous: WebPushIntent, ownerId: string, action: string) => {
        if (previous.revision !== intent.revision || (action === 'enable' && intent.reason === 'logout')) return null
        intent = { ...intent, ownerId, allowed: true, reason: 'active', revision: crypto.randomUUID() }
        return { ...intent }
    })
    mocks.closeWebPushIntent.mockImplementation(async (ownerId: string, reason: 'disabled' | 'logout') => {
        intent = { ...intent, ownerId, allowed: false, reason, revision: crypto.randomUUID() }
        return { ...intent }
    })
    mocks.assertWebPushIntent.mockImplementation(async (previous: WebPushIntent) => {
        if (!intent.allowed || previous.revision !== intent.revision) throw new Error('intent changed')
    })
    mocks.readWebPushAuthority.mockImplementation(async (endpoint: string, _intent: WebPushIntent, pending = false) => {
        const authority = authorities.get(endpoint) ?? { generation: 0, ownerId: null, revocationCredential: 'A'.repeat(43) }
        if (!authorities.has(endpoint) || pending) authorities.set(endpoint, { ...authority, ownerId: null })
        return { ...authority }
    })
    mocks.saveWebPushAuthority.mockImplementation(async (endpoint: string, authority: WebPushAuthority) => { authorities.set(endpoint, authority) })
    mocks.retireWebPushEndpoint.mockImplementation(async (previous: WebPushIntent, endpoint: string) => {
        if (previous.revision !== intent.revision || intent.allowed) return false
        intent = { ...intent, retiredEndpoint: endpoint }; return true
    })
    current = null
    permission = 'default'
    mocks.apiPost.mockImplementation(async (path: string, body: { endpoint?: string }, options?: { beforeSend?: () => Promise<void> }) => {
        await options?.beforeSend?.()
        calls.push(path)
        return path === '/profile/web-push/config' ? { ok: true, publicKey: PUBLIC_KEY }
            : { ok: true, applied: true, generation: (authorities.get(body.endpoint ?? '')?.generation ?? 0) + 1, revocationCredential: 'B'.repeat(43) }
    })
    installBrowser()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

// Logout cleanup runs after this tab already cleared its session (lib/auth.ts signOut).
const LOGOUT = { ownerId: 'owner-a', accessToken: 'signed-out-access' }
const afterLocalSignOut = () => mocks.sessionOwner.mockReturnValue(null)

describe('web push client', () => {
    it('prompts for permission before any network request, then saves the subscription', async () => {
        const { enableWebPush } = await load()
        await expect(enableWebPush()).resolves.toBe('on')
        expect(calls[0]).toBe('requestPermission')
        expect(calls).toEqual(['requestPermission', '/profile/web-push/config', 'subscribe', '/profile/web-push/subscribe'])
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/subscribe', {
            endpoint: 'https://web.push.apple.com/new',
            p256dh: 'p256dh-key',
            auth: 'auth-key', generation: 0, revocationCredential: 'A'.repeat(43),
        }, expect.objectContaining({ expectedUserId: 'owner-a', beforeSend: expect.any(Function) }))
    })

    it('does not close a new owner intent when the initiating auth action expires during capture', async () => {
        const { detachWebPushFromAccount } = await load()
        let currentAuth = true
        mocks.captureWebPushIntent.mockImplementationOnce(async () => {
            currentAuth = false
            intent = { ...intent, ownerId: 'owner-b', revision: 'new-B' }
            return { ...intent }
        })
        afterLocalSignOut()
        await detachWebPushFromAccount(LOGOUT, () => currentAuth)
        expect(mocks.closeWebPushIntent).not.toHaveBeenCalled()
        expect(intent.allowed).toBe(true)
        expect(intent.ownerId).toBe('owner-b')
        expect(pushManager.getSubscription).not.toHaveBeenCalled()
    })
    it('does not touch subscriptions when shared intent comparison rejects closure', async () => {
        const { detachWebPushFromAccount } = await load()
        mocks.closeWebPushIntent.mockResolvedValueOnce(null)
        afterLocalSignOut()
        await detachWebPushFromAccount(LOGOUT)
        expect(pushManager.getSubscription).not.toHaveBeenCalled()
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
    it('reports denied permission without subscribing', async () => {
        vi.mocked(Notification.requestPermission).mockImplementationOnce(async () => {
            permission = 'denied'
            return permission
        })
        const { enableWebPush } = await load()
        await expect(enableWebPush()).resolves.toBe('denied')
        expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('reports unavailable when the server has no VAPID key', async () => {
        mocks.apiPost.mockImplementation(async () => ({ ok: true, publicKey: null }))
        const { getWebPushStatus } = await load()
        await expect(getWebPushStatus()).resolves.toBe('unavailable')
    })

    it('tells iPhone Safari tabs to install the app first', async () => {
        installBrowser({ push: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })
        const { getWebPushStatus, enableWebPush } = await load()
        await expect(getWebPushStatus()).resolves.toBe('needs-install')
        await expect(enableWebPush()).resolves.toBe('needs-install')
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })

    it('re-syncs an existing subscription on launch but never creates one silently', async () => {
        permission = 'granted'
        const { syncWebPushSubscription } = await load()
        await syncWebPushSubscription()
        expect(mocks.apiPost).not.toHaveBeenCalled()

        current = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        await syncWebPushSubscription()
        expect(pushManager.subscribe).not.toHaveBeenCalled()
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/subscribe', expect.objectContaining({
            endpoint: 'https://web.push.apple.com/existing',
        }), expect.objectContaining({ expectedUserId: 'owner-a' }))
    })

    it('requires explicit Enable to replace a subscription minted for a rotated VAPID key', async () => {
        permission = 'granted'
        const stale = fakeSubscription('https://web.push.apple.com/stale', OTHER_KEY_BYTES)
        current = stale
        const { syncWebPushSubscription, enableWebPush } = await load()
        await expect(syncWebPushSubscription()).rejects.toThrow('keys changed')
        expect(stale.unsubscribe).not.toHaveBeenCalled()
        await enableWebPush()
        expect(stale.unsubscribe).toHaveBeenCalled()
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/subscribe', expect.objectContaining({
            endpoint: 'https://web.push.apple.com/new',
        }), expect.objectContaining({ expectedUserId: 'owner-a' }))
    })

    it('detaches on sign-out but keeps the browser subscription; turning off removes both', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/device', keyBytes())
        current = subscription
        const { detachWebPushFromAccount, disableWebPush } = await load()

        afterLocalSignOut()
        await detachWebPushFromAccount(LOGOUT)
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/unsubscribe', { endpoint: 'https://web.push.apple.com/device' },
            { accessToken: 'signed-out-access', beforeSend: expect.any(Function) })
        expect(subscription.unsubscribe).not.toHaveBeenCalled()

        mocks.sessionOwner.mockReturnValue('owner-a')
        mocks.apiPost.mockRejectedValueOnce(new Error('offline'))
        await expect(disableWebPush()).rejects.toThrow('offline')
        expect(subscription.unsubscribe).toHaveBeenCalled()
    })

    it('revokes local delivery when account detach fails during sign-out', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/device', keyBytes())
        current = subscription
        const { detachWebPushFromAccount } = await load()
        mocks.apiPost.mockRejectedValueOnce(new Error('offline'))
        afterLocalSignOut()

        await expect(detachWebPushFromAccount(LOGOUT)).rejects.toThrow('offline')

        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    })

    it('stops browser delivery locally when no session is usable for server cleanup', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/device', keyBytes())
        current = subscription
        const { detachWebPushFromAccount } = await load()
        afterLocalSignOut()

        await expect(detachWebPushFromAccount({ ownerId: 'owner-a', accessToken: null })).rejects.toThrow('needs a session')

        expect(mocks.apiPost).not.toHaveBeenCalled()
        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    })

    it('leaves notifications alone once another account signed in on this tab', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/device', keyBytes())
        current = subscription
        const { detachWebPushFromAccount } = await load()
        mocks.sessionOwner.mockReturnValue('owner-b')

        await detachWebPushFromAccount(LOGOUT)

        expect(mocks.closeWebPushIntent).not.toHaveBeenCalled()
        expect(mocks.apiPost).not.toHaveBeenCalled()
        expect(subscription.unsubscribe).not.toHaveBeenCalled()
        mocks.sessionOwner.mockReturnValue('owner-a')
    })

    it('is a no-op without the Push API (native)', async () => {
        vi.stubGlobal('navigator', { product: 'ReactNative' })
        vi.stubGlobal('window', {})
        const { syncWebPushSubscription, detachWebPushFromAccount, getWebPushStatus } = await load()
        await syncWebPushSubscription()
        await detachWebPushFromAccount(LOGOUT)
        await expect(getWebPushStatus()).resolves.toBe('unsupported')
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
})

describe('web push ownership admission', () => {
    it('requires a durable server acknowledgement before reporting on', async () => {
        permission = 'granted'
        current = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        const { getWebPushStatus, enableWebPush } = await load()
        await expect(getWebPushStatus()).resolves.toBe('off')
        await expect(enableWebPush()).resolves.toBe('on')
        await expect(getWebPushStatus()).resolves.toBe('on')
    })

    it('keeps a lost registration reply off before any failure cleanup', async () => {
        permission = 'granted'
        current = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        authorities.set(current.endpoint, { generation: 1, ownerId: 'owner-a', revocationCredential: 'A'.repeat(43) })
        const normal = mocks.apiPost.getMockImplementation()!
        mocks.apiPost.mockImplementation(async (...args) => {
            if (args[0] === '/profile/web-push/subscribe') {
                expect(authorities.get(current!.endpoint)?.ownerId).toBeNull()
                throw new Error('reply lost')
            }
            return normal(...args)
        })
        const { syncWebPushSubscription, getWebPushStatus } = await load()
        await expect(syncWebPushSubscription()).rejects.toThrow('reply lost')
        await expect(getWebPushStatus()).resolves.toBe('off')
    })

    it('does not admit restored auth or Enable after shared logout closure', async () => {
        permission = 'granted'
        current = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        intent = { ...intent, reason: 'logout', allowed: false }
        const { syncWebPushSubscription, enableWebPush } = await load()
        await syncWebPushSubscription()
        expect(mocks.apiPost).not.toHaveBeenCalled()
        await expect(enableWebPush()).rejects.toThrow('Sign in again')
        expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('withholds replacement authority when durable logout closure fails', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        current = subscription
        mocks.closeWebPushIntent.mockRejectedValueOnce(new Error('storage unavailable'))
        const { detachWebPushFromAccount } = await load()
        afterLocalSignOut()
        await expect(detachWebPushFromAccount(LOGOUT)).rejects.toThrow('storage unavailable')
        expect(mocks.apiPost).toHaveBeenCalledWith('/profile/web-push/unsubscribe', expect.any(Object), expect.any(Object))
        expect(mocks.saveWebPushAuthority).not.toHaveBeenCalled()
        expect(subscription.unsubscribe).toHaveBeenCalledOnce()
        mocks.sessionOwner.mockReturnValue('owner-a')
    })

    it('stops an Enable permission wait when the account changes', async () => {
        let release!: (permission: NotificationPermission) => void
        vi.mocked(Notification.requestPermission).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
        const { enableWebPush } = await load()
        const pending = enableWebPush()
        mocks.sessionOwner.mockReturnValue('owner-b')
        release('granted')
        await expect(pending).rejects.toThrow('action changed')
        expect(mocks.apiPost).not.toHaveBeenCalled()
        expect(pushManager.subscribe).not.toHaveBeenCalled()
    })

    it('does not dispatch a registration when its pending marker cannot be saved', async () => {
        permission = 'granted'
        current = fakeSubscription('https://web.push.apple.com/existing', keyBytes())
        mocks.readWebPushAuthority.mockRejectedValueOnce(new Error('write denied'))
        const { syncWebPushSubscription } = await load()
        await expect(syncWebPushSubscription()).rejects.toThrow('write denied')
        expect(mocks.apiPost.mock.calls.some(([path]) => path === '/profile/web-push/subscribe')).toBe(false)
    })

    it('rejects reuse of a retired endpoint when the browser first reports no subscription', async () => {
        permission = 'granted'
        const endpoint = 'https://web.push.apple.com/new'
        intent = { ...intent, allowed: false, reason: 'disabled', retiredEndpoint: endpoint }
        current = null
        const { enableWebPush } = await load()
        await expect(enableWebPush()).rejects.toThrow('kept the old')
        expect(mocks.apiPost.mock.calls.some(([path]) => path === '/profile/web-push/subscribe')).toBe(false)
    })

    it('does not let an older disable unsubscribe a later admitted endpoint', async () => {
        permission = 'granted'
        const old = fakeSubscription('https://web.push.apple.com/old', keyBytes())
        current = old
        let release!: () => void
        const held = new Promise<void>((resolve) => { release = resolve })
        const normal = mocks.saveWebPushAuthority.getMockImplementation()!
        mocks.saveWebPushAuthority.mockImplementationOnce(async (...args) => { await normal(...args); await held })
        const { disableWebPush, enableWebPush } = await load()
        const pending = disableWebPush()
        await vi.waitFor(() => expect(mocks.saveWebPushAuthority).toHaveBeenCalledOnce())
        await expect(enableWebPush()).resolves.toBe('on')
        release()
        await pending
        expect(old.unsubscribe).toHaveBeenCalledOnce()
        expect(current?.endpoint).toBe('https://web.push.apple.com/new')
    })
})
