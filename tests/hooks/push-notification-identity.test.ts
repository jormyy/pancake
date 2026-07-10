import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { usePushNotifications } from '@/hooks/use-push-notifications'

const mocks = vi.hoisted(() => ({
    userId: 'user-a' as string | null,
    getExpoPushTokenAsync: vi.fn(),
    updates: [] as { userId: string; token: string }[],
}))

vi.mock('expo-device', () => ({ isDevice: true }))
vi.mock('expo-notifications', () => ({
    AndroidImportance: { MAX: 5 },
    getExpoPushTokenAsync: mocks.getExpoPushTokenAsync,
    getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestPermissionsAsync: vi.fn(),
    setNotificationChannelAsync: vi.fn(),
    setNotificationHandler: vi.fn(),
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('@/hooks/use-auth', () => ({
    useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}))
vi.mock('@/lib/supabase', () => ({
    supabase: {
        from: () => ({
            update: ({ push_token: token }: { push_token: string }) => ({
                eq: async (_column: string, userId: string) => {
                    mocks.updates.push({ userId, token })
                    return { error: null }
                },
            }),
        }),
    },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

describe('push notification identity ownership', () => {
    it('does not write a token resolved for a previous signed-in user', async () => {
        mocks.updates.length = 0
        const first = deferred<{ data: string }>()
        const second = deferred<{ data: string }>()
        mocks.getExpoPushTokenAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const Probe = ({ userId }: { userId: string }) => {
            mocks.userId = userId
            usePushNotifications()
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { userId: 'user-a' })); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { userId: 'user-b' })); await Promise.resolve() })
        await act(async () => { first.resolve({ data: 'token-a' }); await first.promise; await Promise.resolve() })

        expect(mocks.updates).not.toContainEqual({ userId: 'user-a', token: 'token-a' })
        await act(async () => { renderer.unmount(); second.resolve({ data: 'token-b' }); await second.promise })
    })
})
