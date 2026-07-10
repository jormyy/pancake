import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getExpoPushTokenAsync: vi.fn(),
    apiPost: vi.fn(),
    storedToken: null as string | null,
}))

vi.mock('expo-device', () => ({ isDevice: true }))
vi.mock('expo-notifications', () => ({ getExpoPushTokenAsync: mocks.getExpoPushTokenAsync }))
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => mocks.storedToken),
    setItemAsync: vi.fn(async (_key: string, value: string) => { mocks.storedToken = value }),
    deleteItemAsync: vi.fn(async () => { mocks.storedToken = null }),
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))

import { registerPushToken, unregisterCurrentDevicePushToken } from '@/lib/push-token'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.storedToken = null
    mocks.apiPost.mockResolvedValue({ ok: true })
})

describe('push token lifecycle', () => {
    it('persists the registered token and revokes that exact token before clearing it', async () => {
        await registerPushToken('ExponentPushToken[registered]', () => true)
        expect(mocks.storedToken).toBe('ExponentPushToken[registered]')

        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('token service offline'))
        await unregisterCurrentDevicePushToken()

        expect(mocks.getExpoPushTokenAsync).not.toHaveBeenCalled()
        expect(mocks.apiPost).toHaveBeenLastCalledWith('/profile/push-token', {
            token: 'ExponentPushToken[registered]',
            active: false,
        })
        expect(mocks.storedToken).toBeNull()
    })

    it('fails closed when no durable token can be identified for revocation', async () => {
        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('token service offline'))

        await expect(unregisterCurrentDevicePushToken()).rejects.toThrow(
            'Could not identify this device push token for revocation.',
        )
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
})
