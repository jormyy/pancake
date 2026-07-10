import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyPushTokenError, usePushNotifications } from '@/hooks/use-push-notifications'

const mocks = vi.hoisted(() => ({
    userId: 'user-a' as string | null,
    getExpoPushTokenAsync: vi.fn(),
    apiPost: vi.fn(),
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
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    mocks.userId = 'user-a'
    mocks.getExpoPushTokenAsync.mockReset()
    mocks.apiPost.mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

describe('push notification identity ownership', () => {
    it('does not write a token resolved for a previous signed-in user', async () => {
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

        expect(mocks.apiPost).not.toHaveBeenCalledWith('/profile/push-token', {
            token: 'token-a',
            active: true,
        })
        await act(async () => { second.resolve({ data: 'token-b' }); await second.promise; await Promise.resolve() })
        expect(mocks.apiPost).toHaveBeenCalledWith('/profile/push-token', {
            token: 'token-b',
            active: true,
        })
        await act(async () => { renderer.unmount() })
    })

    it('classifies build configuration separately from retryable acquisition failures', () => {
        expect(classifyPushTokenError(new Error('No projectId found for this EAS project'))).toBe('configuration')
        expect(classifyPushTokenError(new Error('Push service temporarily unavailable'))).toBe('retryable')
    })

    it('reports and retries a transient token acquisition failure', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        mocks.getExpoPushTokenAsync
            .mockRejectedValueOnce(new Error('Push service temporarily unavailable'))
            .mockResolvedValueOnce({ data: 'token-a' })
        const Probe = () => { usePushNotifications(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledOnce()
        expect(console.error).toHaveBeenCalledWith(
            'Could not acquire an Expo push token.',
            expect.any(Error),
        )

        await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
        expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledTimes(2)
        expect(mocks.apiPost).toHaveBeenCalledWith('/profile/push-token', {
            token: 'token-a',
            active: true,
        })
        await act(async () => { renderer.unmount() })
    })

    it('reports configuration errors without retrying them', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('No projectId configured'))
        const Probe = () => { usePushNotifications(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
        await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve() })

        expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledOnce()
        expect(console.warn).toHaveBeenCalledWith(
            'Push notifications are not configured for this build.',
            expect.any(Error),
        )
        await act(async () => { renderer.unmount() })
    })

    it('stops after the bounded transient retry schedule', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        mocks.getExpoPushTokenAsync.mockRejectedValue(new Error('Push service unavailable'))
        const Probe = () => { usePushNotifications(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })

        await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
        await act(async () => { vi.advanceTimersByTime(5_000); await Promise.resolve() })
        expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledTimes(3)
        expect(vi.mocked(console.error).mock.calls.filter(
            ([message]) => message === 'Could not acquire an Expo push token.',
        )).toHaveLength(3)
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => { renderer.unmount() })
    })

    it('retries transient token persistence failures on a bounded schedule', async () => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        mocks.getExpoPushTokenAsync.mockResolvedValue({ data: 'token-a' })
        mocks.apiPost
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce({ ok: true })
        const Probe = () => { usePushNotifications(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        expect(mocks.apiPost).toHaveBeenCalledOnce()

        await act(async () => { vi.advanceTimersByTime(250); await Promise.resolve() })
        expect(mocks.apiPost).toHaveBeenCalledTimes(2)
        await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
        expect(mocks.apiPost).toHaveBeenCalledTimes(3)
        expect(mocks.getExpoPushTokenAsync).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => { renderer.unmount() })
    })
})
