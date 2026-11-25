import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import LeagueScreen from '@/app/(tabs)/league'

const mocks = vi.hoisted(() => ({
    prefetch: vi.fn(),
    state: {
        current: { id: 'member' }, currentLeague: { id: 'league' }, tab: 'history',
        transactions: [], isTabLoaded: false, isTabLoading: true,
        isTabRefreshing: false, isOnline: true, tabErr: null as string | null,
        retryCurrentTab: vi.fn(), handleTabChange: vi.fn(),
    },
}))

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } }))
vi.mock('@/components/ui', () => ({ Page: 'Page', PageHeader: 'PageHeader', SegmentedControl: 'SegmentedControl', ErrorBanner: 'ErrorBanner' }))
vi.mock('@/components/ui/Card', () => ({ Card: 'Card' }))
vi.mock('@/components/ui/SectionBand', () => ({ SectionBand: 'SectionBand' }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusOverlay: 'ScreenStatusOverlay', ScreenStatusProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/hooks/use-league-screen-state', () => ({ useLeagueScreenState: () => mocks.state }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: undefined }) }))
vi.mock('@/components/league/prefetchLeagueViews', () => ({ prefetchLeagueViews: mocks.prefetch }))
vi.mock('@/components/league/LeaguePlayoffs', () => ({ LeaguePlayoffs: 'LeaguePlayoffs' }))
vi.mock('@/components/league/LeagueActivityFeed', () => ({ ActivityFeed: 'ActivityFeed' }))
vi.mock('@/components/league/LeagueHistory', () => ({ LeagueHistory: 'LeagueHistory' }))
vi.mock('@/components/league/LeagueStandings', () => ({ StandingsTable: 'StandingsTable' }))
vi.mock('@/components/league/LeagueSchedule', () => ({ LeagueSchedule: 'LeagueSchedule' }))
vi.mock('@/components/league/DraftSetupPanels', () => ({ DraftPanel: 'DraftPanel' }))
vi.mock('@/components/league/MockRoomsPanel', () => ({ MockRoomsPanel: 'MockRoomsPanel' }))
vi.mock('@/components/league/SettingsPanel', () => ({ SettingsPanel: 'SettingsPanel' }))
vi.mock('@/components/league/LeaguePicksBank', () => ({ PicksBankList: 'PicksBankList' }))
vi.mock('@/components/league/LeagueMoreCard', () => ({ LeagueMoreCard: 'LeagueMoreCard' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/ScreenErrorFallback', () => ({ ScreenErrorFallback: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    mocks.prefetch.mockClear()
    Object.assign(mocks.state, { tab: 'history', isTabLoaded: false, isTabLoading: true, isTabRefreshing: false, isOnline: true, tabErr: null })
})

it('paints the More panel frame before its data arrives', async () => {
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(LeagueScreen)) })
    try {
        expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith('league', 'member')
        expect(screen.root.findByProps({ role: 'tabpanel' }).props['aria-label']).toBe('Activity league section')
        expect(screen.root.findAllByType('SectionBand' as React.ElementType)).toHaveLength(1)
        expect(screen.root.findAllByType('ActivityFeed' as React.ElementType)).toHaveLength(0)
        mocks.state.isTabLoaded = true
        mocks.state.isTabLoading = false
        await act(async () => { screen.update(React.createElement(LeagueScreen)) })
        expect(screen.root.findByType('ActivityFeed' as React.ElementType)).toBeTruthy()
    } finally {
        await act(async () => screen.unmount())
    }
})
