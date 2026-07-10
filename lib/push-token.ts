import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { apiPost } from '@/lib/shared/api'

const PERSIST_RETRY_DELAYS_MS = [250, 1_000]
const REGISTERED_PUSH_TOKEN_KEY = 'pancake.registered-push-token.v1'
const PENDING_PUSH_TOKEN_REVOCATION_KEY = 'pancake.pending-push-token-revocation.v1'

let mutationQueue: Promise<void> = Promise.resolve()

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const pending = mutationQueue.catch(() => undefined).then(operation)
    mutationQueue = pending.catch(() => undefined)
    return pending
}

async function persistToken(
    token: string,
    active: boolean,
    ownsRequest: () => boolean,
): Promise<void> {
    for (let attempt = 0; ownsRequest(); attempt += 1) {
        try {
            await enqueueMutation(async () => {
                if (!ownsRequest()) return
                await apiPost('/profile/push-token', { token, active })
            })
            return
        } catch (error) {
            const delay = PERSIST_RETRY_DELAYS_MS[attempt]
            if (delay == null || !ownsRequest()) throw error
            await wait(delay)
        }
    }
}

async function readRegisteredPushToken(): Promise<string | null> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        return localStorage.getItem(REGISTERED_PUSH_TOKEN_KEY)
    }
    return SecureStore.getItemAsync(REGISTERED_PUSH_TOKEN_KEY)
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

async function storeRegisteredPushToken(token: string): Promise<void> {
    await storeValue(REGISTERED_PUSH_TOKEN_KEY, token)
}

async function clearRegisteredPushToken(): Promise<void> {
    await clearStoredValue(REGISTERED_PUSH_TOKEN_KEY)
}

export async function registerPushToken(token: string, ownsRequest: () => boolean): Promise<void> {
    const pendingRevocation = await readStoredValue(PENDING_PUSH_TOKEN_REVOCATION_KEY)
    if (pendingRevocation && ownsRequest()) {
        try {
            await persistToken(pendingRevocation, false, ownsRequest)
            if (ownsRequest()) await clearStoredValue(PENDING_PUSH_TOKEN_REVOCATION_KEY)
        } catch {
            // Registering the current token transfers ownership server-side, so a
            // failed best-effort cleanup must not block the current signed-in user.
        }
    }
    await persistToken(token, true, ownsRequest)
    if (ownsRequest()) await storeRegisteredPushToken(token)
}

export async function unregisterCurrentDevicePushToken(): Promise<void> {
    let token = await readRegisteredPushToken()
    if (!token) {
        if (!Device.isDevice) return
        try {
            token = (await Notifications.getExpoPushTokenAsync()).data
        } catch (error) {
            throw new Error('Could not identify this device push token for revocation.', { cause: error })
        }
    }
    try {
        await persistToken(token, false, () => true)
        await clearStoredValue(PENDING_PUSH_TOKEN_REVOCATION_KEY)
    } catch (error) {
        await storeValue(PENDING_PUSH_TOKEN_REVOCATION_KEY, token)
        throw error
    } finally {
        await clearRegisteredPushToken()
    }
}
