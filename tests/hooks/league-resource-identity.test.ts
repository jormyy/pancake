import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'

const { getMockDraftRooms } = vi.hoisted(() => ({ getMockDraftRooms: vi.fn() }))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => ReactModule.useEffect(callback, [callback]) }
})
vi.mock('@/lib/scoring', () => ({ getLeagueStandings: vi.fn(async () => []) }))
vi.mock('@/lib/waivers', () => ({ getWaiverPriorityOrder: vi.fn(async () => []) }))
vi.mock('@/lib/transactions', () => ({ getLeagueTransactions: vi.fn(async () => []) }))
vi.mock('@/lib/rookieDraft', () => ({ getAllLeaguePicks: vi.fn(async () => []) }))
vi.mock('@/lib/mockDraftRooms', () => ({ getMockDraftRooms }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('league resource identity', () => {
    it('does not commit mock rooms loaded for the previous member in the same league', async () => {
        const first = deferred<{ id: string }[]>()
        const second = deferred<{ id: string }[]>()
        getMockDraftRooms.mockImplementation((_leagueId: string, memberId: string) =>
            memberId === 'member-a' ? first.promise : second.promise)
        let latest!: ReturnType<typeof useLeagueTabResources>
        const Probe = ({ memberId }: { memberId: string }) => {
            latest = useLeagueTabResources('league', memberId, 'mockRooms')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b' })) })
        await act(async () => { first.resolve([{ id: 'stale' }]); await first.promise })
        expect(latest.mockRooms).toEqual([])
        await act(async () => { second.resolve([{ id: 'current' }]); await second.promise })
        expect(latest.mockRooms.map((room) => room.id)).toEqual(['current'])
        renderer.unmount()
    })

    it('queues one authoritative mock-room refresh behind an inflight read', async () => {
        const first = deferred<{ id: string }[]>()
        const second = deferred<{ id: string }[]>()
        getMockDraftRooms.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        let latest!: ReturnType<typeof useLeagueTabResources>
        const Probe = () => {
            latest = useLeagueTabResources('league', 'member', 'mockRooms')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let refresh!: Promise<void>
        await act(async () => { refresh = latest.refreshMockRooms() })
        expect(getMockDraftRooms).toHaveBeenCalledTimes(1)
        await act(async () => { first.resolve([{ id: 'stale' }]); await first.promise })
        expect(getMockDraftRooms).toHaveBeenCalledTimes(2)
        await act(async () => { second.resolve([{ id: 'fresh' }]); await refresh })
        expect(latest.mockRooms.map((room) => room.id)).toEqual(['fresh'])
        await act(async () => { renderer.unmount() })
    })
})
