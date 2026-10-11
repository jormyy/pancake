import { apiPost } from '@/lib/shared/api'
import { errorCode } from '@/lib/shared/errors'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'
import {
    admitWebPushIntent, assertWebPushIntent, captureWebPushIntent, closeWebPushIntent,
    readWebPushAuthority, retireWebPushEndpoint, saveWebPushAuthority,
    type WebPushIntent,
} from '@/lib/web-push-state'

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

let operationGeneration = 0

type Identity = { ownerId: string; generation: number; operation: number }
type Operation = Identity & { intent: WebPushIntent }
type RegistrationReceipt = { applied: boolean; generation?: number; revocationCredential?: string }

function identity(): Identity {
    const ownerId = sessionOwner()
    if (!ownerId) throw new Error('Sign in to manage notifications.')
    return { ownerId, generation: sessionGeneration(), operation: operationGeneration }
}

function assertIdentity(captured: Identity): void {
    if (captured.ownerId !== sessionOwner() || captured.generation !== sessionGeneration()
        || captured.operation !== operationGeneration) throw new Error('Your notification action changed. Please retry.')
}

async function assertOperation(operation: Operation): Promise<void> {
    assertIdentity(operation)
    await assertWebPushIntent(operation.intent)
    assertIdentity(operation)
}

async function remember(endpoint: string, receipt: RegistrationReceipt, ownerId: string | null): Promise<void> {
    if (!receipt.applied) return
    if (typeof receipt.generation !== 'number' || typeof receipt.revocationCredential !== 'string') {
        throw new Error('Notification registration acknowledgement is missing.')
    }
    await saveWebPushAuthority(endpoint, { generation: receipt.generation, revocationCredential: receipt.revocationCredential, ownerId })
}

async function saveSubscription(subscription: PushSubscription, operation: Operation): Promise<void> {
    await assertOperation(operation)
    const authority = await readWebPushAuthority(subscription.endpoint, operation.intent, true)
    if (!authority) throw new Error('Your notification action changed. Please retry.')
    const json = subscription.toJSON()
    const receipt = await apiPost<RegistrationReceipt>('/profile/web-push/subscribe', {
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        generation: authority.generation,
        revocationCredential: authority.revocationCredential,
    }, { expectedUserId: operation.ownerId, beforeSend: () => assertOperation(operation) })
    if (!receipt.applied) throw new Error('Notification registration was not confirmed.')
    await remember(subscription.endpoint, receipt, operation.ownerId)
    await assertOperation(operation)
}

async function replaceSubscription(worker: ServiceWorkerRegistration, previous: PushSubscription | null, publicKey: string, operation: Operation): Promise<PushSubscription> {
    await assertOperation(operation)
    if (previous && !await previous.unsubscribe()) throw new Error('Could not reset notifications. Please retry.')
    await assertOperation(operation)
    const next = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
    await assertOperation(operation)
    if (next.endpoint === previous?.endpoint || next.endpoint === operation.intent.retiredEndpoint) throw new Error('The browser kept the old notification registration. Please retry.')
    return next
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
    if (!hasPushApi()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported'
    if (Notification.permission === 'denied') return 'denied'
    const publicKey = await getWebPushPublicKey().catch(() => null)
    if (!publicKey) return 'unavailable'
    const worker = await registration()
    if (!worker) return 'unsupported'
    if (Notification.permission !== 'granted') return 'off'
    try {
        const captured = identity()
        const intent = await captureWebPushIntent()
        const operation = { ...captured, intent }
        if (!intent.allowed || intent.ownerId !== captured.ownerId) return 'off'
        const subscription = await worker.pushManager.getSubscription()
        if (!subscription || subscription.endpoint === intent.retiredEndpoint || !sameKey(subscription, publicKey)) return 'off'
        const authority = await readWebPushAuthority(subscription.endpoint, intent)
        await assertOperation(operation)
        return authority?.ownerId === captured.ownerId && authority.generation > 0 ? 'on' : 'off'
    } catch { return 'off' }
}

/** The permission prompt starts in the tap, before any network request. */
export async function enableWebPush(): Promise<WebPushStatus> {
    if (!hasPushApi()) return getWebPushStatus()
    const captured = identity()
    const previous = captureWebPushIntent()
    const requestedPermission = Notification.requestPermission()
    const prior = await previous
    const permission = await requestedPermission
    assertIdentity(captured)
    if (permission === 'denied') return 'denied'
    if (permission !== 'granted') return 'off'
    const intent = await admitWebPushIntent(prior, captured.ownerId, 'enable')
    if (!intent?.allowed) throw new Error('Sign in again before enabling notifications.')
    const operation = { ...captured, intent }
    await assertOperation(operation)
    const publicKey = await getWebPushPublicKey()
    await assertOperation(operation)
    if (!publicKey) return 'unavailable'
    const worker = await registration()
    await assertOperation(operation)
    if (!worker) return 'unsupported'
    let subscription = await worker.pushManager.getSubscription()
    await assertOperation(operation)
    if (!subscription || prior.reason === 'disabled' || subscription.endpoint === intent.retiredEndpoint || !sameKey(subscription, publicKey)) subscription = await replaceSubscription(worker, subscription, publicKey, operation)
    try { await saveSubscription(subscription, operation) }
    catch (error) {
        if (errorCode(error) !== 'WEB_PUSH_STALE') throw error
        subscription = await replaceSubscription(worker, subscription, publicKey, operation)
        await saveSubscription(subscription, operation)
    }
    return 'on'
}

export async function prepareWebPushLogin(): Promise<WebPushIntent | null> {
    if (!hasPushApi()) return null
    try { return await captureWebPushIntent() }
    catch (error) { console.warn('Notification storage is unavailable.', error); return null }
}

export async function completeWebPushLogin(previous: WebPushIntent | null, ownerId: string): Promise<void> {
    if (!previous) return
    try {
        const intent = await admitWebPushIntent(previous, ownerId, 'login')
        if (intent?.allowed) void syncWebPushSubscription().catch((error) => console.warn('Web push re-sync failed.', error))
    } catch (error) { console.warn('Notification registration remains off.', error) }
}

async function detach(reason: 'logout' | 'disabled'): Promise<void> {
    if (!hasPushApi()) return
    operationGeneration += 1
    const ownerId = sessionOwner() ?? null
    const capturedGeneration = sessionGeneration()
    const capturedOperation = operationGeneration
    let closedIntent: WebPushIntent | null = null
    let closeError: unknown
    try { closedIntent = await closeWebPushIntent(ownerId, reason) }
    catch (error) { closeError = error }
    const stillOwner = () => sessionOwner() === ownerId && sessionGeneration() === capturedGeneration
        && operationGeneration === capturedOperation
    const stillCurrent = async () => {
        if (!stillOwner()) return false
        if (!closedIntent) return true
        const current = await captureWebPushIntent()
        return stillOwner() && current.revision === closedIntent.revision
    }
    if (!await stillCurrent()) return
    const worker = await registration()
    if (!await stillCurrent()) return
    const subscription = await worker?.pushManager.getSubscription()
    if (!await stillCurrent()) return
    if (!subscription) { if (closeError) throw closeError; return }
    const unsubscribe = async () => {
        if (!await stillCurrent()) return
        if (closedIntent && !await retireWebPushEndpoint(closedIntent, subscription.endpoint)) return
        if (!stillOwner()) return
        if (!await subscription.unsubscribe()) throw new Error('Could not stop browser notifications. Please retry.')
    }
    try {
        if (!ownerId) throw new Error('Sign in to remove this notification registration.')
        const receipt = await apiPost<RegistrationReceipt>('/profile/web-push/unsubscribe', { endpoint: subscription.endpoint }, {
            expectedUserId: ownerId,
            beforeSend: async () => { if (!await stillCurrent()) throw new Error('Your notification action changed. Please retry.') },
        })
        // Failed closure must never publish new authority to tabs that still see an open gate.
        if (closedIntent) await remember(subscription.endpoint, receipt, null)
    } catch (error) {
        await unsubscribe()
        throw error
    }
    if (reason === 'disabled' || !closedIntent) await unsubscribe()
    if (closeError) throw closeError
}

/** Logout closes registration in every tab before clearing the account binding. */
export async function detachWebPushFromAccount(): Promise<void> { await detach('logout') }

export async function disableWebPush(): Promise<void> { await detach('disabled') }

/** Restored sessions use existing admitted state; only explicit actions can reopen it. */
export async function syncWebPushSubscription(): Promise<void> {
    if (!hasPushApi() || Notification.permission !== 'granted') return
    const captured = identity()
    const intent = await captureWebPushIntent()
    if (!intent.allowed || intent.ownerId !== captured.ownerId) return
    const operation = { ...captured, intent }
    await assertOperation(operation)
    const worker = await registration()
    await assertOperation(operation)
    if (!worker) return
    const subscription = await worker.pushManager.getSubscription()
    await assertOperation(operation)
    if (!subscription) return
    if (subscription.endpoint === intent.retiredEndpoint) throw new Error('Enable notifications again to replace the previous registration.')
    const publicKey = await getWebPushPublicKey()
    await assertOperation(operation)
    if (!publicKey) return
    if (!sameKey(subscription, publicKey)) throw new Error('Notification keys changed. Enable notifications again.')
    await saveSubscription(subscription, operation)
}

export async function sendTestWebPush(): Promise<{ sent: number; pruned: number; failed: number }> {
    return apiPost('/profile/web-push/test', {})
}
