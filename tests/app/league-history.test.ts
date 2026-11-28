import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeagueHistory } from '@/components/league/LeagueHistory'
import { LeagueTradeHistory } from '@/components/league/LeagueTradeHistory'
import LeagueScreen from '@/app/(tabs)/league'
import type { CompletedTradeHistory, ManagerTradeCount, SeasonHistory } from '@/lib/league-history'

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(),
    change: vi.fn(),
    prefetch: vi.fn(),
    state: {
        current: { id: 'member' }, currentLeague: { id: 'league' }, tab: 'seasons',
        seasons: [] as SeasonHistory[], isTabLoaded: true, isTabLoading: false,
        trades: [] as CompletedTradeHistory[], tradeCounts: [] as ManagerTradeCount[],
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
vi.mock('@/hooks/use-league-screen-state', () => ({ useLeagueScreenState: () => ({ ...mocks.state, retryCurrentTab: mocks.refresh, handleTabChange: mocks.change }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: undefined }) }))
vi.mock('@/components/league/LeaguePlayoffs', () => ({ LeaguePlayoffs: 'LeaguePlayoffs' }))
vi.mock('@/components/league/LeagueActivityFeed', () => ({ ActivityFeed: 'ActivityFeed' }))
vi.mock('@/components/league/LeagueStandings', () => ({ StandingsTable: 'StandingsTable' }))
vi.mock('@/components/league/LeagueSchedule', () => ({ LeagueSchedule: 'LeagueSchedule' }))
vi.mock('@/components/league/DraftSetupPanels', () => ({ DraftPanel: 'DraftPanel' }))
vi.mock('@/components/league/MockRoomsPanel', () => ({ MockRoomsPanel: 'MockRoomsPanel' }))
vi.mock('@/components/league/SettingsPanel', () => ({ SettingsPanel: 'SettingsPanel' }))
vi.mock('@/components/league/LeaguePicksBank', () => ({ PicksBankList: 'PicksBankList' }))
vi.mock('@/components/league/LeagueMoreCard', () => ({ LeagueMoreCard: 'LeagueMoreCard' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/league/prefetchLeagueViews', () => ({ prefetchLeagueViews: mocks.prefetch }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' } }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seasons: SeasonHistory[] = [2025, 2026].map(year => ({
    id: String(year), year, champion: { memberId: 'champion', teamName: `Champion ${year}` },
    stats: { teams: 2, games: 20, pointsFor: 4567.8 },
    standings: [
        { memberId: 'champion', teamName: `Champion ${year}`, finalRank: 1, regularSeasonRank: 2, wins: 8, losses: 1, ties: 1, pointsFor: 2345.6, pointsAgainst: 2222.2, playoffResult: 'Champion' },
        { memberId: 'runner-up', teamName: 'Runner-up team', finalRank: 2, regularSeasonRank: 1, wins: 9, losses: 1, ties: 0, pointsFor: 2222.2, pointsAgainst: 2345.6, playoffResult: 'Runner-up' },
    ],
}))

const tradeCounts: ManagerTradeCount[] = [
    { memberId: 'champion', teamName: 'Champion team', count: 2 },
    { memberId: 'runner-up', teamName: 'Runner-up team', count: 2 },
    { memberId: 'third', teamName: 'Third team', count: 1 },
    { memberId: 'zero', teamName: 'Zero trades', count: 0 },
]

const trades: CompletedTradeHistory[] = [
    {
        id: 'newer', completedAt: '2026-01-02T12:00:00Z',
        participants: [
            { memberId: 'champion', teamName: 'Champion team', received: [{ kind: 'player', label: 'Player One' }] },
            { memberId: 'runner-up', teamName: 'Runner-up team', received: [{ kind: 'pick', label: '2027 Round 1 (orig. Runner-up team)' }, { kind: 'player', label: 'Player Two' }] },
        ],
    },
    {
        id: 'older', completedAt: '2025-12-01T12:00:00Z',
        participants: [
            { memberId: 'champion', teamName: 'Champion team', received: [{ kind: 'player', label: 'Player Three' }] },
            { memberId: 'runner-up', teamName: 'Runner-up team', received: [] },
            { memberId: 'third', teamName: 'Third team', received: [{ kind: 'player', label: 'Player Four' }] },
        ],
    },
]

let screen: ReactTestRenderer | undefined
const host = (type: string) => type as React.ElementType
const text = () => screen!.root.findAllByType(host('Text')).map(node => node.children.join('')).join('\n')

beforeEach(() => {
    mocks.refresh.mockClear()
    mocks.prefetch.mockClear()
    Object.assign(mocks.state, { tab: 'seasons', seasons: [], trades: [], tradeCounts: [], isTabLoaded: true, isTabLoading: false, isTabRefreshing: false, isOnline: true, tabErr: null })
})

afterEach(async () => {
    if (screen) await act(async () => screen!.unmount())
    screen = undefined
})

describe('League History', () => {
    it('shows an empty state when no season is complete', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons: [], trades: [], tradeCounts: [], onRefresh: mocks.refresh })) })
        expect(screen!.root.findByType(host('EmptyState')).props.message).toBe('No completed seasons yet.')
        expect(screen!.root.findAllByType(host('Card'))).toHaveLength(0)
    })

    it('lists newest seasons first, opens final standings, and returns to all seasons', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, trades: [], tradeCounts: [], onRefresh: mocks.refresh })) })
        const cards = screen!.root.findAllByType(host('Card'))
        expect(cards.map(card => card.props.accessibilityLabel)).toEqual([
            'Open 2025–26 season, champion Champion 2026',
            'Open 2024–25 season, champion Champion 2025',
        ])
        await act(async () => cards[0].props.onPress())
        expect(text()).toContain('Final standings')
        expect(text()).toContain('8-1-1')
        expect(text()).toContain('9-1')
        expect(text()).toContain('2346')
        expect(text()).toContain('2222')
        expect(text()).toContain('Runner-up')
        expect(text()).toContain('4568')
        expect(text()).toContain('Regular-season points')
        expect(text()).not.toContain('Champion 2025')
        const rows = screen!.root.findAll(node => node.props.role === 'listitem')
        expect(rows.map(row => row.props.accessibilityLabel)).toEqual([
            'Place 1, Champion 2026, Champion, record 8-1-1, 2346 points for, 2222 points against',
            'Place 2, Runner-up team, Runner-up, record 9-1-0, 2222 points for, 2346 points against',
        ])
        await act(async () => screen!.root.findByType(host('Button')).props.onPress())
        expect(screen!.root.findAllByType(host('Card'))).toHaveLength(2)
    })

    it('wires pull refresh and keeps the selected season on refreshed data', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, trades: [], tradeCounts: [], onRefresh: mocks.refresh, refreshing: true })) })
        await act(async () => screen!.root.findAllByType(host('Card'))[0].props.onPress())
        const refresh = screen!.root.findByType(host('ScrollView')).props.refreshControl
        expect(refresh.props.refreshing).toBe(true)
        await act(async () => refresh.props.onRefresh())
        expect(mocks.refresh).toHaveBeenCalledOnce()
        await act(async () => { screen!.update(React.createElement(LeagueHistory, { seasons: [...seasons], trades: [], tradeCounts: [], onRefresh: mocks.refresh })) })
        expect(text()).toContain('Final standings')
    })

    it('defaults to Winners and keeps the existing season list', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, onRefresh: mocks.refresh, trades, tradeCounts })) })
        const view = screen!.root.findByType(host('SegmentedControl'))
        expect(view.props.options).toEqual([{ label: 'Winners', value: 'winners' }, { label: 'Trade History', value: 'trades' }])
        expect(view.props.value).toBe('winners')
        expect(screen!.root.findByProps({ nativeID: 'history-view-panel' }).props.accessibilityLabel).toBe('Winners')
        expect(text()).toContain('Completed Pancake seasons')
        expect(screen!.root.findAllByType(host('Card')).map(card => card.props.accessibilityLabel)).toEqual([
            'Open 2025–26 season, champion Champion 2026',
            'Open 2024–25 season, champion Champion 2025',
        ])
        expect(text()).not.toContain('Trades by manager')
    })

    it('lists completed trades newest first and counts every manager including zero', async () => {
        await act(async () => { screen = create(React.createElement(LeagueHistory, { seasons, onRefresh: mocks.refresh, trades, tradeCounts })) })
        await act(async () => screen!.root.findByType(host('SegmentedControl')).props.onChange('trades'))
        expect(text()).toContain('Trades by manager')
        expect(screen!.root.findByProps({ nativeID: 'history-view-panel' }).props.accessibilityLabel).toBe('Trade History')
        const managerRows = screen!.root.findAll(node => node.props.role === 'listitem' && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('trade'))
        expect(managerRows.map(row => row.props.accessibilityLabel)).toEqual([
            'Champion team, 2 trades',
            'Runner-up team, 2 trades',
            'Third team, 1 trade',
            'Zero trades, 0 trades',
        ])
        expect(text()).toContain('Player One')
        expect(text()).toContain('2027 Round 1 (orig. Runner-up team)')
        expect(text()).toContain('Received no assets')
        const completed = screen!.root.findAll(node => node.props.role === 'listitem' && node.props.accessibilityLabel?.startsWith('Trade completed'))
        expect(completed.map(row => row.props.accessibilityLabel)).toEqual([
            'Trade completed Jan 2, 2026: Champion team, Runner-up team',
            'Trade completed Dec 1, 2025: Champion team, Runner-up team, Third team',
        ])
        await act(async () => screen!.root.findByType(host('SegmentedControl')).props.onChange('winners'))
        expect(text()).toContain('Completed Pancake seasons')
        expect(text()).not.toContain('Trades by manager')
    })

    it('shows the trade empty state while keeping every manager at zero', async () => {
        await act(async () => {
            screen = create(React.createElement(LeagueHistory, {
                seasons: [], onRefresh: mocks.refresh, trades: [],
                tradeCounts: [{ memberId: 'zero', teamName: 'Zero trades', count: 0 }],
            }))
        })
        await act(async () => screen!.root.findByType(host('SegmentedControl')).props.onChange('trades'))
        expect(screen!.root.findByType(host('EmptyState')).props.message).toBe('No completed trades yet.')
        expect(screen!.root.findByType(host('EmptyState')).props.description).toBe('Completed trades in this league appear here.')
        expect(text()).toContain('Zero trades')
        expect(text()).toContain('0')
    })

    it('orders tied managers by team name with numeric collation', async () => {
        await act(async () => {
            screen = create(React.createElement(LeagueTradeHistory, {
                trades: [],
                tradeCounts: [
                    { memberId: 'ten', teamName: 'E2E Team 10', count: 1 },
                    { memberId: 'four', teamName: 'E2E Team 4', count: 1 },
                ],
            }))
        })
        const rows = screen!.root.findAll(node => node.props.role === 'listitem' && typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('trade'))
        expect(rows.map(row => row.props.accessibilityLabel)).toEqual(['E2E Team 4, 1 trade', 'E2E Team 10, 1 trade'])
    })

    it('shows History from the League tab after loading', async () => {
        mocks.state.seasons = seasons
        mocks.state.trades = trades
        mocks.state.tradeCounts = tradeCounts
        mocks.state.isTabLoaded = false
        mocks.state.isTabLoading = true
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        expect(screen!.root.findAllByType(LeagueHistory)).toHaveLength(0)
        expect(screen!.root.findByProps({ role: 'tabpanel' }).props['aria-label']).toBe('History league section')
        expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith('league', 'member')
        mocks.state.isTabLoaded = true
        mocks.state.isTabLoading = false
        await act(async () => { screen!.update(React.createElement(LeagueScreen)) })
        expect(screen!.root.findByType(LeagueHistory).props.seasons).toBe(seasons)
        expect(screen!.root.findByType(LeagueHistory).props.trades).toBe(trades)
        expect(screen!.root.findByType(LeagueHistory).props.tradeCounts).toBe(tradeCounts)
        const header = screen!.root.findByType(host('PageHeader')).props
        expect(header.tabs).toBeUndefined()
        expect(header.title).toBe('History')
        expect(header.onBack).toBeTypeOf('function')
        expect(screen!.root.findByProps({ role: 'tabpanel' }).props['aria-label']).toBe('History league section')
    })

    it('leads with Standings, Schedule and Playoffs and lists the other views in a More card', async () => {
        mocks.state.tab = 'results'
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        const header = screen!.root.findByType(host('PageHeader')).props
        expect(header.tabs.props.options).toEqual([
            { value: 'results', label: 'Standings' },
            { value: 'schedule', label: 'Schedule' },
            { value: 'bracket', label: 'Playoffs' },
        ])
        expect(header.tabs.props.scrollable).toBeUndefined()
        expect(header.onBack).toBeUndefined()
        const footer = screen!.root.findByType(host('StandingsTable')).props.footer
        expect(footer.type).toBe('LeagueMoreCard')
        expect(footer.props.activeTab).toBe('results')
        expect(footer.props.onSelect).toBe(mocks.change)
        expect(screen!.root.findByProps({ role: 'tabpanel' }).props['aria-label']).toBe('Standings league section')
    })

    it('renders Playoffs under the same League header and tab panel', async () => {
        mocks.state.tab = 'bracket'
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        const page = screen!.root.findByType(host('Page'))
        expect(page.props.title).toBe('League')
        const tabs = page.findByType(host('PageHeader')).props.tabs
        expect(tabs.props.value).toBe('bracket')
        expect(tabs.props.options).toContainEqual({ value: 'bracket', label: 'Playoffs' })
        const panel = page.findByProps({ role: 'tabpanel' })
        expect(panel.props['aria-label']).toBe('Playoffs league section')
        expect(panel.findByType(host('LeaguePlayoffs')).props.playoffEntrants).toBeUndefined()
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
        await act(async () => { screen!.update(React.createElement(LeagueScreen)) })
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
