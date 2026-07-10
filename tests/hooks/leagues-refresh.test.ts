import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLeagues } from '@/hooks/use-leagues'

const mocks = vi.hoisted(() => ({
    fetchUserLeagues: vi.fn(),
    userId: 'user' as string | null,
    cache: new Map<string, unknown>(),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }) }))
vi.mock('@/lib/league', () => ({ fetchUserLeagues: mocks.fetchUserLeagues }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn((key: string) => mocks.cache.get(key)),
    removePersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
}))
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: vi.fn(() => ({ topic: 'leagues' })),
    unsubscribeFromTableChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('league refresh contract', () => {
    beforeEach(() => {
        mocks.userId = 'user'
        mocks.cache.clear()
        mocks.fetchUserLeagues.mockReset()
    })

    it('returns the authoritative load promise', async () => {
        let resolveRefresh!: (rows: never[]) => void
        const pending = new Promise<never[]>((resolve) => { resolveRefresh = resolve })
        mocks.fetchUserLeagues.mockResolvedValueOnce([]).mockReturnValueOnce(pending)
        let latest!: ReturnType<typeof useLeagues>
        const Probe = () => { latest = useLeagues(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })

        let settled = false
        let refresh!: Promise<void>
        await act(async () => {
            refresh = latest.refresh().then(() => { settled = true })
            await Promise.resolve()
        })
        expect(settled).toBe(false)
        await act(async () => { resolveRefresh([]); await refresh })
        expect(settled).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('never returns memberships owned by the previous authenticated user', async () => {
        const membership = (id: string) => ({ id, role: 'manager', team_name: id, leagues: { id: `league-${id}` } })
        mocks.cache.set('pancake:league-memberships:v1:user-a', [membership('member-a')])
        mocks.cache.set('pancake:league-memberships:v1:user-b', [membership('member-b')])
        mocks.fetchUserLeagues.mockImplementation(async (userId: string) => [membership(`server-${userId}`)])
        let latest!: ReturnType<typeof useLeagues>
        const Probe = ({ userId }: { userId: string | null }) => {
            mocks.userId = userId
            latest = useLeagues()
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { userId: 'user-a' })); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { userId: 'user-b' })) })
        expect(latest.memberships.every((row) => !row.id.includes('user-a'))).toBe(true)
        await act(async () => { renderer.unmount() })
    })
})
