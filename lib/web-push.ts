import { apiPost } from '@/lib/shared/api'

// Standards Web Push for the installed PWA. Native builds use Expo push
// (lib/push-token.ts); everything here is a no-op off web.

export type WebPushStatus =
    | 'unsupported'   // browser has no Push API
    | 'needs-install' // iOS Safari tab: push only exists once added to the Home Screen
    | 'unavailable'   // server has no VAPID keys configured
    | 'off'           // supported, not yet enabled on this device
    | 'denied'        // user blocked notifications in the browser/OS
    | 'on'

let publicKeyRequest: Promise<string | null> | null = null

function isIos(): boolean {
    if (typeof navigator === 'undefined') return false
    // iPadOS reports a desktop Mac user agent; touch support tells them apart.
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function isStandalone(): boolean {
    if (typeof window === 'undefined') return false
    return window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
}

// Feature-detected rather than Platform-gated so lib/auth.ts can import this
// without pulling react-native into its tests; native has no PushManager.
function hasPushApi(): boolean {
    return typeof window !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
    const current = subscription.options?.applicationServerKey
    if (!current) return true // older engines do not expose it; assume unchanged
    const expected = base64UrlToBytes(publicKey)
    const actual = new Uint8Array(current)
    return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

/** Fetches (once per session) the server's VAPID public key; null when web push is unconfigured. */
export function getWebPushPublicKey(): Promise<string | null> {
    publicKeyRequest ??= apiPost<{ publicKey: string | null }>('/profile/web-push/config', {})
        .then((result) => result.publicKey)
        .catch((error) => {
            publicKeyRequest = null
            throw error
        })
    return publicKeyRequest
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
    // The worker is only registered in production builds (see app/+html.tsx).
    const existing = await navigator.serviceWorker.getRegistration()
    if (!existing) return null
    return navigator.serviceWorker.ready
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
    const json = subscription.toJSON()
    await apiPost('/profile/web-push/subscribe', {
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
    })
}

async function subscribe(worker: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
    const existing = await worker.pushManager.getSubscription()
    if (existing && sameKey(existing, publicKey)) return existing
    // A subscription minted for a rotated VAPID key can never be delivered to.
    if (existing) await existing.unsubscribe().catch(() => false)
    return worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
    })
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
    if (!hasPushApi()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
    if (Notification.permission === 'denied') return 'denied'
    const publicKey = await getWebPushPublicKey().catch(() => null)
    if (!publicKey) return 'unavailable'
    const worker = await registration()
    if (!worker) return 'unsupported'
    if (Notification.permission !== 'granted') return 'off'
    return (await worker.pushManager.getSubscription()) ? 'on' : 'off'
}

/**
 * Must run directly from a tap: Safari only shows the permission prompt for a
 * user gesture, so the prompt is requested before any network round-trip.
 */
export async function enableWebPush(): Promise<WebPushStatus> {
    if (!hasPushApi()) return getWebPushStatus()
    const permission = await Notification.requestPermission()
    if (permission === 'denied') return 'denied'
    if (permission !== 'granted') return 'off'
    const publicKey = await getWebPushPublicKey()
    if (!publicKey) return 'unavailable'
    const worker = await registration()
    if (!worker) return 'unsupported'
    await saveSubscription(await subscribe(worker, publicKey))
    return 'on'
}

/**
 * Sign-out: stop delivering this account's notifications here, but keep the
 * browser subscription so the next sign-in re-attaches it without a prompt
 * (matching native, which re-registers its Expo token on sign-in).
 */
export async function detachWebPushFromAccount(): Promise<void> {
    if (!hasPushApi()) return
    const worker = await registration()
    const subscription = await worker?.pushManager.getSubscription()
    if (!subscription) return
    await apiPost('/profile/web-push/unsubscribe', { endpoint: subscription.endpoint })
}

export async function disableWebPush(): Promise<void> {
    if (!hasPushApi()) return
    const worker = await registration()
    const subscription = await worker?.pushManager.getSubscription()
    if (!subscription) return
    try {
        await apiPost('/profile/web-push/unsubscribe', { endpoint: subscription.endpoint })
    } finally {
        // Even if the server call fails, a dead endpoint is pruned on the next send (410).
        await subscription.unsubscribe().catch(() => false)
    }
}

/**
 * Re-registers this device on launch when permission is already granted. This
 * attaches the subscription to whoever is signed in and heals subscriptions the
 * browser rotated or the server pruned. Never prompts.
 */
export async function syncWebPushSubscription(): Promise<void> {
    if (!hasPushApi() || Notification.permission !== 'granted') return
    const worker = await registration()
    if (!worker) return
    const existing = await worker.pushManager.getSubscription()
    if (!existing) return // the user turned it off on this device; respect that
    const publicKey = await getWebPushPublicKey()
    if (!publicKey) return
    await saveSubscription(await subscribe(worker, publicKey))
}

export async function sendTestWebPush(): Promise<{ sent: number; pruned: number; failed: number }> {
    return apiPost('/profile/web-push/test', {})
}
