import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { apiPost } from '@/lib/shared/api'

const PERSIST_RETRY_DELAYS_MS = [250, 1_000]

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

export function registerPushToken(token: string, ownsRequest: () => boolean): Promise<void> {
    return persistToken(token, true, ownsRequest)
}

export async function unregisterCurrentDevicePushToken(): Promise<void> {
    if (!Device.isDevice) return
    let token: string
    try {
        token = (await Notifications.getExpoPushTokenAsync()).data
    } catch {
        return
    }
    await persistToken(token, false, () => true)
}
