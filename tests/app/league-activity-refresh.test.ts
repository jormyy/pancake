import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import LeagueScreen from '@/app/(tabs)/league'
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ tab: 'history' }), useRouter: () => ({ dismissTo: vi.fn() }) }))
vi.mock('@/components/navigation/LeagueHome', () => ({ LeagueHome: 'LeagueHome' }))

const refresh = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@/hooks/use-league-screen-state', () => ({ useLeagueScreenState: () => ({ current: { id: 'member' }, tab: 'history', isTabLoaded: true, isTabRefreshing: true, transactions: [], retryCurrentTab: refresh }) }))
vi.mock('@/components/ui', () => ({ Page: 'Page', PageHeader: 'PageHeader', SegmentedControl: 'SegmentedControl', ErrorBanner: 'ErrorBanner' }))
vi.mock('@/components/league/LeagueActivityFeed', () => ({ ActivityFeed: 'ActivityFeed' }))
vi.mock('@/components/league/LeagueStandings', () => ({ StandingsTable: 'StandingsTable' }))
vi.mock('@/components/league/LeagueSchedule', () => ({ LeagueSchedule: 'LeagueSchedule' }))
vi.mock('@/components/league/DraftSetupPanels', () => ({ DraftPanel: 'DraftPanel' }))
vi.mock('@/components/league/MockRoomsPanel', () => ({ MockRoomsPanel: 'MockRoomsPanel' }))
vi.mock('@/components/league/SettingsPanel', () => ({ SettingsPanel: 'SettingsPanel' }))
vi.mock('@/components/league/LeaguePicksBank', () => ({ PicksBankList: 'PicksBankList' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('wires Activity pull refresh to the current panel refresh', async () => {
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(LeagueScreen)) })
        const feed = screen.root.findByType('ActivityFeed' as React.ElementType)
        expect(feed.props.onRefresh).toBe(refresh)
        expect(feed.props.refreshing).toBe(true)
        await act(async () => { await feed.props.onRefresh() })
        expect(refresh).toHaveBeenCalledOnce()
    } finally { await act(async () => screen.unmount()) }
})
