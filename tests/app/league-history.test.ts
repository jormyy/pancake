import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeagueHistory } from '@/components/league/LeagueHistory'
import LeagueScreen from '@/app/(tabs)/league'
import type { SeasonHistory } from '@/lib/league-history'

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(),
    state: {
        current: { id: 'member' }, currentLeague: { id: 'league' }, tab: 'seasons',
        seasons: [] as SeasonHistory[], isTabLoaded: true, isTabLoading: false,
        isTabRefreshing: false, isOnline: true, tabErr: null as string | null,
    },
}))

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', RefreshControl: 'RefreshControl', Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@/components/ui', () => ({
    Page: 'Page', PageHeader: 'PageHeader', SegmentedControl: 'SegmentedControl', ErrorBanner: 'ErrorBanner',
    usePageMetrics: () => ({ padX: 16 }),
}))
vi.mock('@/components/ui/Card', () => ({ Card: 'Card' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/ListHeader', () => ({ ListHeader: 'ListHeader' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({
    ScreenStatusScrollView: 'ScrollView', ScreenStatusOverlay: 'ScreenStatusOverlay', ScreenStatusProvider: 'ScreenStatusProvider',
}))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ ready, children }: { ready: boolean; children: React.ReactNode }) => ready ? children : null }))
vi.mock('@/hooks/use-league-screen-state', () => ({ useLeagueScreenState: () => ({ ...mocks.state, retryCurrentTab: mocks.refresh }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: undefined }) }))
vi.mock('@/components/league/LeagueActivityFeed', () => ({ ActivityFeed: 'ActivityFeed' }))
vi.mock('@/components/league/LeagueStandings', () => ({ StandingsTable: 'StandingsTable' }))
vi.mock('@/components/league/LeagueSchedule', () => ({ LeagueSchedule: 'LeagueSchedule' }))
vi.mock('@/components/league/DraftSetupPanels', () => ({ DraftPanel: 'DraftPanel' }))
vi.mock('@/components/league/MockRoomsPanel', () => ({ MockRoomsPanel: 'MockRoomsPanel' }))
vi.mock('@/components/league/SettingsPanel', () => ({ SettingsPanel: 'SettingsPanel' }))
vi.mock('@/components/league/LeaguePicksBank', () => ({ PicksBankList: 'PicksBankList' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seasons: SeasonHistory[] = [2025, 2026].map(year => ({
    id: String(year), year, champion: { memberId: 'champion', teamName: `Champion ${year}` },
    stats: { teams: 2, games: 20, pointsFor: 4567.8 },
    standings: [
        { memberId: 'champion', teamName: `Champion ${year}`, finalRank: 1, regularSeasonRank: 2, wins: 8, losses: 1, ties: 1, pointsFor: 2345.6, pointsAgainst: 2222.2, playoffResult: 'Champion' },
        { memberId: 'runner-up', teamName: 'Runner-up team', finalRank: 2, regularSeasonRank: 1, wins: 9, losses: 1, ties: 0, pointsFor: 2222.2, pointsAgainst: 2345.6, playoffResult: 'Runner-up' },
    ],
}))

let screen: ReactTestRenderer | undefined
const host = (type: string) => type as React.ElementType
const text = () => screen!.root.findAllByType(host('Text')).map(node => node.children.join('')).join('\n')

beforeEach(() => {
    mocks.refresh.mockClear()
    Object.assign(mocks.state, { seasons: [], isTabLoaded: true, isTabLoading: false, isTabRefreshing: false, isOnline: true, tabErr: null })
})

afterEach(async () => {
    if (screen) await act(async () => screen!.unmount())
    screen = undefined
})

describe('League History', () => {
    it('shows an empty state when no season is complete', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons: [], onRefresh: mocks.refresh })) })
        expect(screen!.root.findByType(host('EmptyState')).props.message).toBe('No completed seasons yet.')
        expect(screen!.root.findAllByType(host('Card'))).toHaveLength(0)
    })

    it('lists newest seasons first, opens final standings, and returns to all seasons', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, onRefresh: mocks.refresh })) })
        const cards = screen!.root.findAllByType(host('Card'))
        expect(cards.map(card => card.props.accessibilityLabel)).toEqual([
            'Open 2025–26 season, champion Champion 2026',
            'Open 2024–25 season, champion Champion 2025',
        ])
        await act(async () => cards[0].props.onPress())
        expect(text()).toContain('Final standings')
        expect(text()).toContain('8-1-1')
        expect(text()).toContain('9-1')
        expect(text()).toContain('2345.6')
        expect(text()).toContain('2222.2')
        expect(text()).toContain('Runner-up')
        expect(text()).toContain('4567.8')
        expect(text()).toContain('Regular-season points')
        expect(text()).not.toContain('Champion 2025')
        const rows = screen!.root.findAll(node => node.props.role === 'listitem')
        expect(rows.map(row => row.props.accessibilityLabel)).toEqual([
            'Place 1, Champion 2026, Champion, record 8-1-1, 2345.6 points for, 2222.2 points against',
            'Place 2, Runner-up team, Runner-up, record 9-1-0, 2222.2 points for, 2345.6 points against',
        ])
        await act(async () => screen!.root.findByType(host('Button')).props.onPress())
        expect(screen!.root.findAllByType(host('Card'))).toHaveLength(2)
    })

    it('wires pull refresh and keeps the selected season on refreshed data', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, onRefresh: mocks.refresh, refreshing: true })) })
        await act(async () => screen!.root.findAllByType(host('Card'))[0].props.onPress())
        const refresh = screen!.root.findByType(host('ScrollView')).props.refreshControl
        expect(refresh.props.refreshing).toBe(true)
        await act(async () => refresh.props.onRefresh())
        expect(mocks.refresh).toHaveBeenCalledOnce()
        await act(async () => screen!.update(React.createElement(LeagueHistory, { seasons: [...seasons], onRefresh: mocks.refresh })) )
        expect(text()).toContain('Final standings')
    })

    it('shows History from the League tab after loading', async () => {
        mocks.state.seasons = seasons
        mocks.state.isTabLoaded = false
        mocks.state.isTabLoading = true
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        expect(screen!.root.findAllByType(LeagueHistory)).toHaveLength(0)
        mocks.state.isTabLoaded = true
        mocks.state.isTabLoading = false
        await act(async () => screen!.update(React.createElement(LeagueScreen)))
        expect(screen!.root.findByType(LeagueHistory).props.seasons).toBe(seasons)
        const options = screen!.root.findByType(host('PageHeader')).props.tabs.props.options
        expect(options).toContainEqual({ value: 'seasons', label: 'History' })
        expect(options).toContainEqual({ value: 'history', label: 'Activity' })
    })

    it('shows a retry after a failed load and preserves saved history after a failed refresh', async () => {
        mocks.state.isTabLoaded = false
        mocks.state.tabErr = 'Unavailable'
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        let banner = screen!.root.findByType(host('ErrorBanner'))
        expect(banner.props.message).toBe('History could not load. Select to retry.')
        await act(async () => banner.props.onRetry())
        expect(mocks.refresh).toHaveBeenCalledOnce()
        mocks.state.isTabLoaded = true
        mocks.state.seasons = seasons
        await act(async () => screen!.update(React.createElement(LeagueScreen)))
        banner = screen!.root.findByType(host('ErrorBanner'))
        expect(banner.props.message).toBe('History refresh failed. Showing saved data. Select to retry.')
        expect(screen!.root.findByType(LeagueHistory).props.seasons).toBe(seasons)
    })

    it('keeps saved seasons visible while offline', async () => {
        mocks.state.isOnline = false
        mocks.state.seasons = seasons
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        expect(text()).toContain('Offline. Showing saved History data.')
        expect(screen!.root.findByType(LeagueHistory).props.seasons).toBe(seasons)
    })
})
