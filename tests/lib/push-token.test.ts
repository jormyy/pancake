import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getExpoPushTokenAsync: vi.fn(),
    apiPost: vi.fn(),
    secureValues: new Map<string, string>(),
}))

vi.mock('expo-device', () => ({ isDevice: true }))
vi.mock('expo-notifications', () => ({ getExpoPushTokenAsync: mocks.getExpoPushTokenAsync }))
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (key: string) => mocks.secureValues.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mocks.secureValues.set(key, value) }),
    deleteItemAsync: vi.fn(async (key: string) => { mocks.secureValues.delete(key) }),
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))

import {
    registerPushToken,
    retryPendingPushTokenRevocation,
    unregisterCurrentDevicePushToken,
} from '@/lib/push-token'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.secureValues.clear()
    mocks.apiPost.mockImplementation(async (path: string, body: { active?: boolean }) => path === '/profile/push-token' && body.active
        ? { ok: true, revocationCredential: 'credential-a' }
        : { ok: true })
})

describe('push token lifecycle', () => {
    it('persists the registered token and revokes that exact token before clearing it', async () => {
        await expect(registerPushToken('ExponentPushToken[registered]', () => true)).resolves.toBe(true)
        expect(JSON.parse(mocks.secureValues.get('pancake.registered-push-token.v1') ?? '')).toEqual({
            token: 'ExponentPushToken[registered]',
            revocationCredential: 'credential-a',
        })

        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('token service offline'))
        await unregisterCurrentDevicePushToken()

        expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled()
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/push-token/revoke', {
            token: 'ExponentPushToken[registered]',
            revocationCredential: 'credential-a',
        })
        expect(mocks.secureValues.has('pancake.registered-push-token.v1')).toBe(false)
    })

    it('reports legacy fallback registrations as not credential-backed', async () => {
        mocks.apiPost.mockResolvedValue({ ok: true })

        await expect(registerPushToken('ExponentPushToken[legacy-rollout]', () => true)).resolves.toBe(false)
        expect(JSON.parse(mocks.secureValues.get('pancake.registered-push-token.v1') ?? '')).toEqual({
            token: 'ExponentPushToken[legacy-rollout]',
            revocationCredential: null,
        })
    })

    it('fails closed when no durable token can be identified for revocation', async () => {
        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('token service offline'))

        await expect(unregisterCurrentDevicePushToken()).rejects.toThrow(
            'Could not identify this device push token for revocation.',
        )
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })

    it('retries a queued revocation without an authenticated user session', async () => {
        vi.useFakeTimers()
        await registerPushToken('ExponentPushToken[registered]', () => true)
        mocks.apiPost.mockRejectedValue(new Error('offline'))

        const unregister = unregisterCurrentDevicePushToken()
        const rejected = expect(unregister).rejects.toThrow('offline')
        await vi.advanceTimersByTimeAsync(1_250)
        await rejected
        expect(mocks.secureValues.has('pancake.pending-push-token-revocation.v1')).toBe(true)
        expect(mocks.secureValues.has('pancake.registered-push-token.v1')).toBe(false)

        mocks.apiPost.mockResolvedValue({ ok: true })
        await expect(retryPendingPushTokenRevocation()).resolves.toBe(true)
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/push-token/revoke', {
            token: 'ExponentPushToken[registered]',
            revocationCredential: 'credential-a',
        })
        expect(mocks.secureValues.has('pancake.pending-push-token-revocation.v1')).toBe(false)
        vi.useRealTimers()
    })
})
