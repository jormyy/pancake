import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProfileResource } from '@/hooks/use-profile-resource'
import { clearScreenViews, saveScreenView } from '@/lib/cache/screen-cache'

const state = vi.hoisted(() => ({ owner: 'a', generation: 0, read: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => state.owner, sessionGeneration: () => state.generation, onSessionCachesCleared: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: state.owner }, access_token: state.owner } } }) } } }))
vi.mock('@/lib/notification-preferences', () => ({ DEFAULT_NOTIFICATION_PREFERENCES: { tradeEnabled: false, waiverEnabled: false, draftEnabled: false, activityEnabled: false } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const profile = (id: string) => ({ id, username: id, display_name: id, avatar_url: null, created_at: '' })
const preferences = { tradeEnabled: false, waiverEnabled: true, draftEnabled: true, activityEnabled: false }
const payload = (id: string) => ({ profile: profile(id), preferences })
let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof useProfileResource>
const snapshots: { requested: string; profileId?: string; loaded: boolean }[] = []
const Probe = ({ userId = 'a', type = 'profile' }: { userId?: string; type?: 'profile' | 'preferences' }) => {
    state.owner = userId
    latest = useProfileResource(userId, type)
    snapshots.push({ requested: userId, profileId: latest.profile?.id, loaded: latest.profileLoaded })
    return null
}
beforeEach(() => {
    state.owner = 'a'; state.generation += 1; state.read.mockReset(); clearScreenViews(); snapshots.length = 0
    state.read.mockImplementation(async (id: string) => payload(id))
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => new Response(JSON.stringify({ ok: true, view: await state.read(init.headers && new Headers(init.headers).get('Authorization')?.replace('Bearer ', '')) }))))
})
afterEach(async () => { if (renderer) await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals() })

describe('profile view ownership and readiness', () => {
    it('hides the previous user immediately and ignores its late completion', async () => {
        let resolve!: (value: ReturnType<typeof payload>) => void
        const held = new Promise<ReturnType<typeof payload>>(done => { resolve = done })
        state.read.mockImplementation((id: string) => id === 'a' ? held : Promise.resolve(payload(id)))
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { renderer!.update(React.createElement(Probe, { userId: 'b' })) })
        expect(snapshots.find(row => row.requested === 'b')).toEqual({ requested: 'b', profileId: undefined, loaded: false })
        expect(latest.profile?.id).toBe('b')
        await act(async () => { resolve(payload('a')); await held })
        expect(latest.profile?.id).toBe('b')
    })
    it.each(['profile', 'preferences'] as const)('keeps %s inactive after a failed view and restores it on retry', async type => {
        state.read.mockRejectedValueOnce(new Error('view offline'))
        await act(async () => { renderer = create(React.createElement(Probe, { type })) })
        expect(latest.profileLoaded).toBe(false)
        expect(latest.profileError).toBe('view offline')
        await act(async () => { await latest.retryProfile() })
        expect(latest.profileLoaded).toBe(true)
        expect(latest.profileError).toBeNull()
        expect(latest.profile?.id).toBe('a')
        expect(latest.preferences).toEqual(preferences)
    })
    it('renders saved profile and preferences before the fresh view completes', async () => {
        saveScreenView({ accountId: 'a', screen: 'profile' }, payload('a'), '0')
        state.read.mockReturnValue(new Promise(() => {}))
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(snapshots[0]).toEqual({ requested: 'a', profileId: 'a', loaded: true })
        expect(latest.preferences).toEqual(preferences)
    })
    it.each(['hidden', 'offline'])('defers a %s view until one resume', async mode => {
        const browser = new EventTarget(), page = new EventTarget()
        let hidden = mode === 'hidden', online = mode !== 'offline'
        Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
        vi.stubGlobal('window', browser); vi.stubGlobal('document', page); vi.stubGlobal('navigator', { get onLine() { return online } })
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(state.read).not.toHaveBeenCalled()
        hidden = false; online = true
        await act(async () => { page.dispatchEvent(new Event('visibilitychange')); browser.dispatchEvent(new Event('online')) })
        expect(state.read).toHaveBeenCalledOnce()
        expect(latest.profileLoaded).toBe(true)
    })
})
