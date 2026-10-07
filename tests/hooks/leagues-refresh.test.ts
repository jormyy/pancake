import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLeagues } from '@/hooks/use-leagues'

const mocks = vi.hoisted(() => ({
    fetchUserLeagues: vi.fn(),
    userId: 'user' as string | null,
    online: true,
    cache: new Map<string, unknown>(),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => mocks.online }))
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
        mocks.online = true
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


it('recovers empty memberships on reconnect and clears an authoritative revocation', async () => {
    const rows = [{ id: 'member', leagues: { id: 'league' } }]
    mocks.userId = 'user'
    mocks.online = false
    mocks.cache.clear()
    mocks.fetchUserLeagues.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let latest!: ReturnType<typeof useLeagues>
    const Probe = () => { latest = useLeagues(); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.memberships).toEqual([])
        expect(latest.membershipStatus).toBe('unavailable')
        mocks.online = true
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(latest.memberships).toEqual(rows)
        expect(latest.membershipStatus).toBe('available')
        expect(latest.error).toBeNull()
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(mocks.fetchUserLeagues).toHaveBeenCalledTimes(2)
        mocks.online = false
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(latest.memberships).toEqual(rows)
        mocks.online = true
        await act(async () => { renderer.update(React.createElement(Probe)) })
        expect(latest.memberships).toEqual([])
        expect(latest.membershipStatus).toBe('empty')
        expect(mocks.fetchUserLeagues).toHaveBeenCalledTimes(3)
    } finally {
        await act(async () => { renderer.unmount() })
        log.mockRestore()
    }
})

it('rejects late reconnect results after account switch and logout', async () => {
    mocks.userId = 'user-a'
    mocks.online = false
    mocks.cache.clear()
    let finishOld!: (rows: { id: string }[]) => void
    let finishNew!: (rows: { id: string; leagues: { id: string } }[]) => void
    mocks.fetchUserLeagues.mockReset().mockResolvedValueOnce([])
        .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve }))
        .mockResolvedValueOnce([{ id: 'new-member', leagues: { id: 'new-league' } }])
        .mockReturnValueOnce(new Promise((resolve) => { finishNew = resolve }))
    let latest!: ReturnType<typeof useLeagues>
    const Probe = () => { latest = useLeagues(); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    mocks.online = true
    await act(async () => { renderer.update(React.createElement(Probe)) })
    expect(mocks.fetchUserLeagues).toHaveBeenCalledTimes(2)
    mocks.userId = 'user-b'
    await act(async () => { renderer.update(React.createElement(Probe)) })
    await act(async () => { finishOld([{ id: 'old-member' }]) })
    expect(latest.memberships.map((row) => row.id)).toEqual(['new-member'])
    mocks.online = false
    await act(async () => { renderer.update(React.createElement(Probe)) })
    mocks.online = true
    await act(async () => { renderer.update(React.createElement(Probe)) })
    mocks.userId = null
    await act(async () => { renderer.update(React.createElement(Probe)) })
    await act(async () => { finishNew([{ id: 'new-member', leagues: { id: 'new-league' } }]) })
    expect(latest.memberships).toEqual([])
    expect(latest.membershipStatus).toBe('signed-out')
    expect(mocks.fetchUserLeagues.mock.calls.map(([id]) => id)).toEqual(['user-a', 'user-a', 'user-b', 'user-b'])
    await act(async () => { renderer.unmount() })
})
