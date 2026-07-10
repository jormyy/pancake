import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { apiPost } from '@/lib/shared/api'

const PERSIST_RETRY_DELAYS_MS = [250, 1_000]
const REGISTERED_PUSH_TOKEN_KEY = 'pancake.registered-push-token.v1'

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

async function storeRegisteredPushToken(token: string): Promise<void> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        localStorage.setItem(REGISTERED_PUSH_TOKEN_KEY, token)
        return
    }
    await SecureStore.setItemAsync(REGISTERED_PUSH_TOKEN_KEY, token)
}

async function clearRegisteredPushToken(): Promise<void> {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        localStorage.removeItem(REGISTERED_PUSH_TOKEN_KEY)
        return
    }
    await SecureStore.deleteItemAsync(REGISTERED_PUSH_TOKEN_KEY)
}

export async function registerPushToken(token: string, ownsRequest: () => boolean): Promise<void> {
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
    await persistToken(token, false, () => true)
    await clearRegisteredPushToken()
}
