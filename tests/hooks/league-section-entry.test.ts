import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'

const boundary = vi.hoisted(() => ({ params: {} as { tab?: string }, push: vi.fn(), setParams: vi.fn() }))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => boundary.params, useRouter: () => ({ push: boundary.push, setParams: boundary.setParams }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' }, membershipValidated: true }) }))
vi.mock('@/hooks/use-league-tab-resources', () => ({ useLeagueTabResources: () => ({ activeDraftLoaded: true }) }))
vi.mock('@/hooks/use-league-draft-controller', () => ({ useLeagueDraftController: () => ({}) }))
vi.mock('@/hooks/use-mock-rooms-controller', () => ({ useMockRoomsController: () => ({}) }))
vi.mock('@/lib/invite-share', () => ({ shareInviteMessage: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let state!: ReturnType<typeof useLeagueScreenState>
function Controller() { state = useLeagueScreenState(); return null }
afterEach(async () => { await act(async () => screen?.unmount()); boundary.params = {}; vi.clearAllMocks() })
it('opens Standings and returns there on a fresh League entry', async () => {
    await act(async () => { screen = create(React.createElement(Controller)) })
    expect(state.tab).toBe('results')
    await act(async () => state.handleTabChange('history'))
    expect(state.tab).toBe('history')
    expect(boundary.setParams).toHaveBeenCalledWith({ tab: 'history' })
    boundary.params = { tab: 'history' }
    await act(async () => screen.update(React.createElement(Controller)))
    boundary.params = {}
    await act(async () => screen.update(React.createElement(Controller)))
    expect(state.tab).toBe('results')
})
it.each(['results', 'history', 'picks', 'draft', 'settings'])('opens the direct League section %s', async tab => {
    boundary.params = { tab }
    await act(async () => { screen = create(React.createElement(Controller)) })
    expect(state.tab).toBe(tab)
})
it('opens the Bracket section without replacing the Standings selection', async () => {
    await act(async () => { screen = create(React.createElement(Controller)) })
    await act(async () => state.handleTabChange('bracket'))
    expect(boundary.push).toHaveBeenCalledWith('/(modals)/bracket')
    expect(state.tab).toBe('results')
})
