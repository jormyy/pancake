import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))

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
    current = null
    permission = 'default'
    mocks.apiPost.mockImplementation(async (path: string) => {
        calls.push(path)
        return path === '/profile/web-push/config' ? { ok: true, publicKey: PUBLIC_KEY } : { ok: true }
    })
    installBrowser()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('web push client', () => {
    it('prompts for permission before any network request, then saves the subscription', async () => {
        const { enableWebPush } = await load()
        await expect(enableWebPush()).resolves.toBe('on')
        expect(calls[0]).toBe('requestPermission')
        expect(calls).toEqual(['requestPermission', '/profile/web-push/config', 'subscribe', '/profile/web-push/subscribe'])
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/subscribe', {
            endpoint: 'https://web.push.apple.com/new',
            p256dh: 'p256dh-key',
            auth: 'auth-key',
        })
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
        }))
    })

    it('replaces a subscription minted for a rotated VAPID key', async () => {
        permission = 'granted'
        const stale = fakeSubscription('https://web.push.apple.com/stale', OTHER_KEY_BYTES)
        current = stale
        const { syncWebPushSubscription } = await load()
        await syncWebPushSubscription()
        expect(stale.unsubscribe).toHaveBeenCalled()
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/subscribe', expect.objectContaining({
            endpoint: 'https://web.push.apple.com/new',
        }))
    })

    it('detaches on sign-out but keeps the browser subscription; turning off removes both', async () => {
        permission = 'granted'
        const subscription = fakeSubscription('https://web.push.apple.com/device', keyBytes())
        current = subscription
        const { detachWebPushFromAccount, disableWebPush } = await load()

        await detachWebPushFromAccount('signed-out-access')
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/web-push/unsubscribe', { endpoint: 'https://web.push.apple.com/device' }, { accessToken: 'signed-out-access' })
        expect(subscription.unsubscribe).not.toHaveBeenCalled()

        mocks.apiPost.mockRejectedValueOnce(new Error('offline'))
        await expect(disableWebPush()).rejects.toThrow('offline')
        expect(subscription.unsubscribe).toHaveBeenCalled()
    })

    it('is a no-op without the Push API (native)', async () => {
        vi.stubGlobal('navigator', { product: 'ReactNative' })
        vi.stubGlobal('window', {})
        const { syncWebPushSubscription, detachWebPushFromAccount, getWebPushStatus } = await load()
        await syncWebPushSubscription()
        await detachWebPushFromAccount('signed-out-access')
        await expect(getWebPushStatus()).resolves.toBe('unsupported')
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
})
