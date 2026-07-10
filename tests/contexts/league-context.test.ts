import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LeagueProvider, useLeagueContext } from '@/contexts/league-context'
import type { LeagueMembership } from '@/types/app'

const mocks = vi.hoisted(() => ({
    userId: 'user-a' as string | null,
    memberships: [] as LeagueMembership[],
    loading: false,
    cache: new Map<string, unknown>(),
}))

vi.mock('@/hooks/use-auth', () => ({
    useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}))
vi.mock('@/hooks/use-leagues', () => ({
    useLeagues: () => ({
        memberships: mocks.memberships,
        loading: mocks.loading,
        refresh: vi.fn(),
    }),
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn((key: string) => mocks.cache.get(key) ?? null),
    writePersistentCache: vi.fn((key: string, value: unknown) => { mocks.cache.set(key, value) }),
    removePersistentCache: vi.fn((key: string) => { mocks.cache.delete(key) }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const selectionKey = (userId: string) => `pancake:selected-league:v1:${userId}`

function membership(id: string, leagueId = `league-${id}`): LeagueMembership {
    return {
        id,
        role: 'manager',
        team_name: `Team ${id}`,
        leagues: {
            id: leagueId,
            name: `League ${id}`,
            invite_code: null,
            status: 'active',
            commissioner_id: 'commissioner',
            auction_budget: 200,
            scoring_settings: {},
            playoff_start_week: 20,
            roster_size: 20,
            ir_slots: 2,
        },
    }
}

type Snapshot = ReturnType<typeof useLeagueContext>

describe('LeagueProvider selection ownership', () => {
    let latest!: Snapshot

    function Probe() {
        latest = useLeagueContext()
        return null
    }

    function tree() {
        return React.createElement(LeagueProvider, null, React.createElement(Probe))
    }

    beforeEach(() => {
        mocks.userId = 'user-a'
        mocks.memberships = []
        mocks.loading = false
        mocks.cache.clear()
    })

    it('restores a selected league after the provider remounts', async () => {
        const first = membership('member-a1')
        const selected = membership('member-a2')
        mocks.memberships = [first, selected]
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(tree()) })

        await act(async () => { latest.setCurrent(selected) })
        expect(latest.current?.id).toBe(selected.id)
        await act(async () => { renderer.unmount() })
        await act(async () => { renderer = create(tree()) })

        expect(latest.current?.id).toBe(selected.id)
        await act(async () => { renderer.unmount() })
    })

    it('waits for deferred memberships before validating the stored selection', async () => {
        const first = membership('member-a1')
        const selected = membership('member-a2')
        mocks.cache.set(selectionKey('user-a'), selected.id)
        mocks.loading = true
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(tree()) })

        expect(latest.current).toBeNull()
        expect(mocks.cache.get(selectionKey('user-a'))).toBe(selected.id)

        mocks.memberships = [first, selected]
        mocks.loading = false
        await act(async () => { renderer.update(tree()) })

        expect(latest.current?.id).toBe(selected.id)
        await act(async () => { renderer.unmount() })
    })

    it('replaces a stored selection that is no longer a membership', async () => {
        const available = membership('member-a1')
        mocks.cache.set(selectionKey('user-a'), 'removed-member')
        mocks.memberships = [available]
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(tree()) })

        expect(latest.current?.id).toBe(available.id)
        expect(mocks.cache.get(selectionKey('user-a'))).toBe(available.id)
        await act(async () => { renderer.unmount() })
    })

    it('never carries a selected membership across authenticated users or signout', async () => {
        const selectedA = membership('member-a2')
        const selectedB = membership('member-b2')
        mocks.cache.set(selectionKey('user-a'), selectedA.id)
        mocks.cache.set(selectionKey('user-b'), selectedB.id)
        mocks.memberships = [membership('member-a1'), selectedA]
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(tree()) })
        expect(latest.current?.id).toBe(selectedA.id)

        mocks.userId = 'user-b'
        mocks.memberships = [membership('member-b1'), selectedB]
        await act(async () => { renderer.update(tree()) })
        expect(latest.current?.id).toBe(selectedB.id)
        await act(async () => { latest.setCurrent(selectedA) })
        expect(latest.current?.id).toBe(selectedB.id)
        expect(mocks.cache.get(selectionKey('user-b'))).toBe(selectedB.id)

        mocks.userId = null
        mocks.memberships = []
        await act(async () => { renderer.update(tree()) })
        expect(latest.current).toBeNull()
        await act(async () => { renderer.unmount() })
    })
})
