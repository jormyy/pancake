import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useProfileResource } from '@/hooks/use-profile-resource'

const mocks = vi.hoisted(() => ({ getProfile: vi.fn(), getNotificationPreferences: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getProfile: mocks.getProfile }))
vi.mock('@/lib/notification-preferences', () => ({ getNotificationPreferences: mocks.getNotificationPreferences }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}
const profile = (id: string) => ({ id, username: id, display_name: id, avatar_url: null, push_token: null, push_token_updated_at: null, created_at: '' })

describe('useProfileResource', () => {
    it('hides the previous user immediately and ignores its late completion', async () => {
        const profileA = deferred<ReturnType<typeof profile>>()
        const preferencesA = deferred<{ tradeEnabled: boolean; waiverEnabled: boolean; draftEnabled: boolean; activityEnabled: boolean }>()
        mocks.getProfile.mockImplementation((id: string) => id === 'a' ? profileA.promise : Promise.resolve(profile('b')))
        mocks.getNotificationPreferences.mockImplementation((id: string) => id === 'a'
            ? preferencesA.promise
            : Promise.resolve({ tradeEnabled: false, waiverEnabled: true, draftEnabled: true, activityEnabled: true }))
        let latest!: ReturnType<typeof useProfileResource>
        const snapshots: { requested: string; profileId?: string; loaded: boolean }[] = []
        const Probe = ({ userId }: { userId: string }) => {
            latest = useProfileResource(userId)
            snapshots.push({ requested: userId, profileId: latest.profile?.id, loaded: latest.profileLoaded })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { userId: 'a' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { userId: 'b' })); await Promise.resolve() })

        expect(snapshots.find((snapshot) => snapshot.requested === 'b')).toEqual({
            requested: 'b', profileId: undefined, loaded: false,
        })
        expect(latest.profile?.id).toBe('b')
        expect(latest.preferences.tradeEnabled).toBe(false)

        await act(async () => {
            profileA.resolve(profile('a'))
            preferencesA.resolve({ tradeEnabled: true, waiverEnabled: false, draftEnabled: false, activityEnabled: false })
            await Promise.all([profileA.promise, preferencesA.promise])
        })
        expect(latest.profile?.id).toBe('b')
        expect(latest.preferences.tradeEnabled).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})
