import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { apiPost } from '@/lib/shared/api'

const PERSIST_RETRY_DELAYS_MS = [250, 1_000]
const REGISTERED_PUSH_TOKEN_KEY = 'pancake.registered-push-token.v1'
const PENDING_PUSH_TOKEN_REVOCATION_KEY = 'pancake.pending-push-token-revocation.v1'

type StoredPushRegistration = {
    token: string
    revocationCredential: string | null
}

let mutationQueue: Promise<void> = Promise.resolve()

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function enqueueMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
    const pending = mutationQueue.catch(() => undefined).then(operation)
    mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
}

async function persistMutation<Value>(
    operation: () => Promise<Value>,
    ownsRequest: () => boolean,
): Promise<Value | undefined> {
    for (let attempt = 0; ownsRequest(); attempt += 1) {
        try {
            return await enqueueMutation(async () => {
                if (!ownsRequest()) return undefined
                return operation()
            })
        } catch (error) {
            const delay = PERSIST_RETRY_DELAYS_MS[attempt]
            if (delay == null || !ownsRequest()) throw error
            await wait(delay)
        }
    }
    return undefined
}

function parseStoredRegistration(value: string | null): StoredPushRegistration | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as Partial<StoredPushRegistration>
        if (typeof parsed.token === 'string') {
            return {
                token: parsed.token,
                revocationCredential: typeof parsed.revocationCredential === 'string'
                    ? parsed.revocationCredential
                    : null,
            }
        }
    } catch {
        // Legacy installs stored the raw Expo token.
    }
    return { token: value, revocationCredential: null }
}

async function readStoredValue(key: string): Promise<string | null> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') return localStorage.getItem(key)
    return SecureStore.getItemAsync(key)
}

async function storeValue(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        localStorage.setItem(key, value)
        return
    }
    await SecureStore.setItemAsync(key, value)
}

async function clearStoredValue(key: string): Promise<void> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        localStorage.removeItem(key)
        return
    }
    await SecureStore.deleteItemAsync(key)
}

async function readRegistration(key: string): Promise<StoredPushRegistration | null> {
    return parseStoredRegistration(await readStoredValue(key))
}

async function storeRegistration(key: string, registration: StoredPushRegistration): Promise<void> {
    await storeValue(key, JSON.stringify(registration))
}

async function clearRegisteredPushToken(): Promise<void> {
    await clearStoredValue(REGISTERED_PUSH_TOKEN_KEY)
}

export async function registerPushToken(token: string, ownsRequest: () => boolean): Promise<boolean> {
    await retryPendingPushTokenRevocation()
    const result = await persistMutation(
        () => apiPost<{ revocationCredential?: string }>('/profile/push-token', { token, active: true }),
        ownsRequest,
    )
    if (ownsRequest()) {
        await storeRegistration(REGISTERED_PUSH_TOKEN_KEY, {
            token,
            revocationCredential: result?.revocationCredential ?? null,
        })
    }
    return typeof result?.revocationCredential === 'string'
}

export async function unregisterCurrentDevicePushToken(): Promise<void> {
    let registration = await readRegistration(REGISTERED_PUSH_TOKEN_KEY)
    if (!registration) {
        if (!Device.isDevice) return
        try {
            registration = {
                token: (await Notifications.getExpoPushTokenAsync()).data,
                revocationCredential: null,
            }
        } catch (error) {
            throw new Error('Could not identify this device push token for revocation.', { cause: error })
        }
    }
    try {
        if (registration.revocationCredential) {
            await persistMutation(() => apiPost('/profile/push-token/revoke', {
                token: registration.token,
                revocationCredential: registration.revocationCredential,
            }), () => true)
        } else {
            await persistMutation(
                () => apiPost('/profile/push-token', { token: registration.token, active: false }),
                () => true,
            )
        }
        await clearStoredValue(PENDING_PUSH_TOKEN_REVOCATION_KEY)
    } catch (error) {
        if (registration.revocationCredential) {
            await storeRegistration(PENDING_PUSH_TOKEN_REVOCATION_KEY, registration)
        }
        throw error
    } finally {
        await clearRegisteredPushToken()
    }
}

export async function retryPendingPushTokenRevocation(): Promise<boolean> {
    const pending = await readRegistration(PENDING_PUSH_TOKEN_REVOCATION_KEY)
    if (!pending?.revocationCredential) return true
    try {
        await persistMutation(() => apiPost('/profile/push-token/revoke', {
            token: pending.token,
            revocationCredential: pending.revocationCredential,
        }), () => true)
        await clearStoredValue(PENDING_PUSH_TOKEN_REVOCATION_KEY)
        return true
    } catch {
        return false
    }
}
