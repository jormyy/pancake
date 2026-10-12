import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TeamRosterScreen from '@/app/(modals)/team-roster'
import type { RosterPlayer } from '@/lib/roster'

const mocks = vi.hoisted(() => ({
    context: {
        current: { id: 'own-member' } as { id: string } | null,
        currentLeague: { id: 'league-a' } as { id: string } | null,
        membershipStatus: 'available', refresh: vi.fn(),
    },
    params: { memberId: 'other-member', teamName: 'Other team' },
    getRoster: vi.fn(),
    getStats: vi.fn(),
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => mocks.context }))
vi.mock('@/lib/league', () => ({ isTradingClosed: () => false }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.getRoster }))
vi.mock('@/lib/roster-stats', () => ({ EMPTY_AVG_MAP: new Map(), EMPTY_STATS_MAP: new Map(), getRosterStatsMaps: mocks.getStats }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/roster/RosterItems', () => ({ ReadOnlyRosterPlayerItem: 'RosterPlayer', RosterSectionBand: 'RosterSectionBand' }))
vi.mock('@/components/ui', () => ({
    Button: 'Button', LoadingState: 'LoadingState', Page: 'Page', PageHeader: 'PageHeader', ErrorBanner: 'ErrorBanner',
    usePageMetrics: () => ({ padX: 16, compact: false }),
}))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: 'ScreenErrorFallback' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roster: RosterPlayer[] = [{
    id: 'roster-one', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft',
    players: { id: 'player-one', display_name: 'Player One', position: 'PG', eligible_positions: ['PG'],
        nba_team: 'BOS', injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 1 },
}]

describe('team roster read recovery', () => {
    let screen: ReactTestRenderer
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.context.current = { id: 'own-member' }
        mocks.context.currentLeague = { id: 'league-a' }
        mocks.context.membershipStatus = 'available'
        mocks.params.memberId = 'other-member'
        mocks.getRoster.mockResolvedValue(roster)
        mocks.getStats.mockResolvedValue({ avgMap: new Map(), avgStatsMap: new Map() })
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })
    const mount = async () => { await act(async () => { screen = create(React.createElement(TeamRosterScreen)) }) }
    const empty = () => screen.root.findAll((node) => node.props.message === 'No players yet')
    const retry = () => screen.root.findAll((node) => typeof node.props.onRetry === 'function')

    it('distinguishes a roster failure from an empty team and retries the real read', async () => {
        mocks.getRoster.mockRejectedValueOnce(new Error('roster read failed'))
        await mount()
        expect(empty()).toHaveLength(0)
        expect(screen.root.findAll((node) => node.props.label === 'Active roster')).toHaveLength(0)
        expect(retry()).toHaveLength(1)
        await act(async () => retry()[0].props.onRetry())
        expect(mocks.getRoster).toHaveBeenCalledTimes(2)
        expect(screen.root.findAll((node) => node.props.item?.id === 'roster-one')).toHaveLength(1)
        expect(retry()).toHaveLength(0)
    })

    it('retains roster identities when averages fail and offers retry', async () => {
        mocks.getStats.mockRejectedValueOnce(new Error('averages read failed'))
        await mount()
        expect(screen.root.findAll((node) => node.props.item?.id === 'roster-one')).toHaveLength(1)
        expect(empty()).toHaveLength(0)
        expect(retry()).toHaveLength(1)
        await act(async () => retry()[0].props.onRetry())
        expect(mocks.getStats).toHaveBeenCalledTimes(2)
        expect(retry()).toHaveLength(0)
    })

    it('still shows the empty team state after a successful empty read', async () => {
        mocks.getRoster.mockResolvedValue([])
        await mount()
        expect(empty()).toHaveLength(1)
        expect(retry()).toHaveLength(0)
    })

    it('keeps known players when the averages retry cannot refresh the roster', async () => {
        mocks.getStats.mockRejectedValueOnce(new Error('averages read failed'))
        await mount()
        mocks.getRoster.mockRejectedValueOnce(new Error('roster retry failed'))
        await act(async () => retry()[0].props.onRetry())
        expect(screen.root.findAll((node) => node.props.item?.id === 'roster-one')).toHaveLength(1)
        expect(retry()).toHaveLength(1)
        expect(empty()).toHaveLength(0)
    })

    it('waits for membership before reporting roster contents', async () => {
        mocks.context.current = null
        mocks.context.currentLeague = null
        mocks.context.membershipStatus = 'loading'
        await mount()
        expect(empty()).toHaveLength(0)
        expect(mocks.getRoster).not.toHaveBeenCalled()
        mocks.context.current = { id: 'own-member' }
        mocks.context.currentLeague = { id: 'league-a' }
        mocks.context.membershipStatus = 'available'
        await act(async () => { screen.update(React.createElement(TeamRosterScreen)) })
        expect(mocks.getRoster).toHaveBeenCalledWith('other-member', 'league-a')
        expect(screen.root.findAll((node) => node.props.item?.id === 'roster-one')).toHaveLength(1)
    })

    it('retries missing league access without claiming an empty team', async () => {
        mocks.context.current = null
        mocks.context.currentLeague = null
        mocks.context.membershipStatus = 'unavailable'
        await mount()
        expect(empty()).toHaveLength(0)
        expect(retry()).toHaveLength(1)
        await act(async () => retry()[0].props.onRetry())
        expect(mocks.context.refresh).toHaveBeenCalledTimes(1)
        expect(mocks.getRoster).not.toHaveBeenCalled()
    })

    it('does not retain a different team after a failed read', async () => {
        await mount()
        mocks.params.memberId = 'another-member'
        mocks.getRoster.mockRejectedValueOnce(new Error('new team read failed'))
        await act(async () => { screen.update(React.createElement(TeamRosterScreen)) })
        expect(screen.root.findAll((node) => node.props.item?.id === 'roster-one')).toHaveLength(0)
        expect(empty()).toHaveLength(0)
        expect(retry()).toHaveLength(1)
    })
})
