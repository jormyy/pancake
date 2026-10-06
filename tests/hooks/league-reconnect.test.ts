import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { useLeagueTabResources } from '@/hooks/use-league-tab-resources'

const state = vi.hoisted(() => ({ online: true, focused: true, standings: vi.fn(), history: vi.fn(), rooms: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => state.online }))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => {
        ReactModule.useEffect(() => state.focused ? callback() : undefined, [callback, state.focused])
    } }
})
vi.mock('@/lib/scoring', () => ({ getLeagueStandings: state.standings }))
vi.mock('@/lib/transactions', () => ({ getLeagueTransactions: state.history }))
vi.mock('@/lib/mockDraftRooms', () => ({ getMockDraftRooms: state.rooms }))
vi.mock('@/lib/waivers', () => ({ getWaiverPriorityOrder: vi.fn(async () => []) }))
vi.mock('@/lib/rookieDraft', () => ({ getAllLeaguePicks: vi.fn(async () => []) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: vi.fn(() => null), writePersistentCache: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
    vi.clearAllMocks()
    state.online = true
    state.focused = true
    state.standings.mockResolvedValue([{ memberId: 'saved' }])
    state.history.mockResolvedValue([])
    state.rooms.mockResolvedValue([])
})

it('refreshes visible standings on reconnect without fetching hidden tabs or dropping saved data', async () => {
    let latest!: ReturnType<typeof useLeagueTabResources>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useLeagueTabResources('league', 'member', 'results'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    state.online = false
    await act(async () => { renderer.update(React.createElement(Probe)) })
    let resolve!: (rows: { memberId: string }[]) => void
    state.standings.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    state.online = true
    await act(async () => { renderer.update(React.createElement(Probe)) })
    expect(state.standings).toHaveBeenCalledTimes(2)
    expect(state.history).toHaveBeenCalledTimes(1)
    expect(latest.standings[0].memberId).toBe('saved')
    await act(async () => { resolve([{ memberId: 'fresh' }]) })
    expect(latest.standings[0].memberId).toBe('fresh')
    await act(async () => { renderer.unmount() })
})

it('defers hidden-screen reconnect reads until focus returns', async () => {
    let renderer!: ReactTestRenderer
    const Probe = () => { useLeagueTabResources('league', 'member', 'results'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    state.focused = false
    state.online = false
    await act(async () => { renderer.update(React.createElement(Probe)) })
    state.online = true
    await act(async () => { renderer.update(React.createElement(Probe)) })
    expect(state.standings).toHaveBeenCalledTimes(1)
    state.focused = true
    await act(async () => { renderer.update(React.createElement(Probe)) })
    expect(state.standings).toHaveBeenCalledTimes(2)
    await act(async () => { renderer.unmount() })
})

it('coalesces reconnect and mutation invalidation behind an inflight history read', async () => {
    let finish!: (rows: { id: string }[]) => void
    state.history.mockReturnValueOnce(new Promise((done) => { finish = done })).mockResolvedValueOnce([{ id: 'authoritative' }])
    let latest!: ReturnType<typeof useLeagueTabResources>
    let renderer!: ReactTestRenderer
    const Probe = () => { latest = useLeagueTabResources('league', 'member', 'history'); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    state.online = false
    await act(async () => { renderer.update(React.createElement(Probe)) })
    state.online = true
    await act(async () => { renderer.update(React.createElement(Probe)); latest.invalidateTab('history') })
    expect(state.history).toHaveBeenCalledTimes(1)
    await act(async () => { finish([{ id: 'old' }]) })
    expect(state.history).toHaveBeenCalledTimes(2)
    expect(latest.transactions.map((row) => row.id)).toEqual(['authoritative'])
    await act(async () => { renderer.unmount() })
})

it('ignores the previous league response after reconnect and a league switch', async () => {
    let finish!: (rows: { memberId: string }[]) => void
    state.standings.mockImplementation((league: string) => league === 'first'
        ? new Promise((done) => { finish = done })
        : Promise.resolve([{ memberId: 'second-member' }]))
    let latest!: ReturnType<typeof useLeagueTabResources>
    let renderer!: ReactTestRenderer
    const Probe = ({ league }: { league: string }) => {
        latest = useLeagueTabResources(league, 'member', 'results')
        return null
    }
    await act(async () => { renderer = create(React.createElement(Probe, { league: 'first' })) })
    state.online = false
    await act(async () => { renderer.update(React.createElement(Probe, { league: 'first' })) })
    state.online = true
    await act(async () => { renderer.update(React.createElement(Probe, { league: 'second' })) })
    await act(async () => { finish([{ memberId: 'first-member' }]) })
    expect(latest.standings.map((row) => row.memberId)).toEqual(['second-member'])
    await act(async () => { renderer.unmount() })
})
