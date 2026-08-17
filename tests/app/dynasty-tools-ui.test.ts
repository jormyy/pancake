import React from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DynastyScreen from '@/app/(tabs)/dynasty'
import TradeAnalyzer from '@/components/trades/TradeAnalyzer'
import {
    dynastyAnalyzerLatestRouteCacheKey,
    dynastyAnalyzerLatestScopeCacheKey,
    dynastyAnalyzerSnapshotCacheKey,
} from '@/lib/dynasty-decisions'

const mocks = vi.hoisted(() => ({
    getLeagueMembers: vi.fn(),
    readPersistentCache: vi.fn(),
    writePersistentCache: vi.fn(),
    useDynastyTradeAnalysis: vi.fn(),
    useOnlineStatus: vi.fn(),
    useDynastyRankings: vi.fn(),
    composer: {
        participantName: () => 'Team', reset: vi.fn(), participantIds: [] as string[], setParticipantIds: vi.fn(),
        prefillFromTrade: vi.fn(), buildMultiTeamItems: () => [], assetsReady: true, participantViews: [],
        toggleParticipant: vi.fn(), selectedParticipantIds: new Set(), rosterError: null, rosterLoading: false,
        avgMap: new Map(), avgStatsMap: new Map(), retry: vi.fn(), toggleParticipantPlayer: vi.fn(),
        toggleParticipantPick: vi.fn(), setParticipantDestination: vi.fn(), setParticipantPlayerDestination: vi.fn(),
        setParticipantPickDestination: vi.fn(), setParticipantFaab: vi.fn(),
    },
}))

vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: () => null }))
vi.mock('@shopify/flash-list', () => ({ FlashList: () => null }))
vi.mock('@/components/ui', async () => {
    const RuntimeReact = await import('react')
    return {
        Card: 'View', ErrorBanner: () => null, Input: 'TextInput',
        SegmentedControl: ({ options, value }: { options: { label: string; value: string }[]; value: string }) =>
            RuntimeReact.createElement('View', {}, options.map((option) => RuntimeReact.createElement('Pressable', {
                key: option.value,
                accessibilityRole: 'tab',
                accessibilityLabel: option.label,
                accessibilityState: { selected: option.value === value },
            }))),
    }
})
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('@/components/ItemSeparator', () => ({ ItemSeparator: () => null }))
vi.mock('@/components/PosTag', () => ({ PosTag: () => null }))
vi.mock('@/components/trades/MultiTeamTradeBuilder', () => ({ MultiTeamTradeBuilder: () => null }))
vi.mock('@/components/trades/TradeAnalysisSummary', () => ({ TradeAnalysisSummary: () => null }))
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Image: 'Image', Modal: 'Modal', Pressable: 'Pressable',
    ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    NativeModules: {},
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web', select: <Value,>(options: { web?: Value; default?: Value }) => options.web ?? options.default },
    StyleSheet: { create: <Value,>(value: Value) => value },
    useWindowDimensions: () => ({ width: 1_024, height: 768 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({
    useLeagueContext: () => ({
        current: { id: 'member', team_name: 'My Team' },
        currentLeague: {
            id: 'league', scoring_settings: { points: 1 }, waiver_mode: 'faab', faab_starting_budget: 100,
        },
    }),
}))
vi.mock('@/hooks/use-focus-async-data', () => ({
    useFocusAsyncData: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/hooks/use-dynasty-rankings', () => ({ useDynastyRankings: mocks.useDynastyRankings }))
vi.mock('@/lib/dynasty', () => ({ getDynastyNews: vi.fn(), getMyDynastyNews: vi.fn() }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: mocks.getLeagueMembers, isTradingClosed: () => false }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: mocks.readPersistentCache, writePersistentCache: mocks.writePersistentCache,
}))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: mocks.useOnlineStatus }))
vi.mock('@/hooks/use-dynasty-trade-analysis', () => ({
    useDynastyTradeAnalysis: mocks.useDynastyTradeAnalysis,
}))
vi.mock('@/hooks/use-multi-team-trade-composer', () => ({
    useMultiTeamTradeComposer: () => mocks.composer,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLeagueMembers.mockResolvedValue([])
    mocks.readPersistentCache.mockReturnValue(null)
    mocks.useOnlineStatus.mockReturnValue(true)
    mocks.useDynastyTradeAnalysis.mockReturnValue({
        analysis: null, seasonYear: null, loading: false, error: null,
    })
    mocks.useDynastyRankings.mockReturnValue({
        query: '', setQuery: vi.fn(), view: 'five-year', setView: vi.fn(), players: [], loading: false,
        refreshing: false, loadingMore: false, hasMore: false, error: null, loadMoreError: null,
        loadMore: vi.fn(), retryLoadMore: vi.fn(), refresh: vi.fn(),
    })
})

describe('dynasty tools UI', () => {
    it('renders only the three requested ranking tabs with 5-year selected', async () => {
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(DynastyScreen)) })
        const tabs = renderer.root.findAll((node) => node.props.accessibilityRole === 'tab')
        const rankingTabs = tabs.filter((node) => ['5-Year Points', '3-Year Points', 'Rookies & Picks']
            .includes(node.props.accessibilityLabel))

        expect(rankingTabs.map((node) => node.props.accessibilityLabel)).toEqual([
            '5-Year Points', '3-Year Points', 'Rookies & Picks',
        ])
        expect(rankingTabs.map((node) => node.props.accessibilityState?.selected)).toEqual([true, false, false])
        expect(tabs.some((node) => ['Overall', 'Contend', 'Rebuild'].includes(node.props.accessibilityLabel))).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('renders Trade Analyzer with one fixed 5-year outlook', async () => {
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })
        const rendered = JSON.stringify(renderer.toJSON())
        const strategyControls = renderer.root.findAll((node) => node.props.accessibilityLabel === 'Trade strategy')

        expect(rendered).toContain('5-year dynasty outlook')
        expect(strategyControls).toHaveLength(0)
        await act(async () => { renderer.unmount() })
    })

    it('finds the last complete 12-team snapshot on a cold offline start', async () => {
        const scope = {
            userId: 'user', memberId: 'member', leagueId: 'league', seasonYear: 2042,
            scoringSignature: '[["points",1]]', teams: 12, faabBudget: 100,
        }
        const route = 'member>other:player:player-1'
        const scopeKey = dynastyAnalyzerLatestScopeCacheKey(scope)
        const latestRouteKey = dynastyAnalyzerLatestRouteCacheKey(scope)
        const snapshotKey = dynastyAnalyzerSnapshotCacheKey(scope, route)
        mocks.useOnlineStatus.mockReturnValue(false)
        mocks.readPersistentCache.mockImplementation((key: string) => {
            if (key === scopeKey) return scope
            if (key === latestRouteKey) return route
            if (key === snapshotKey) return {
                analysis: { assets: [{ assetId: 'player-1' }], teams: [] },
                participantNames: {}, savedAt: '2026-08-17T00:00:00Z',
                leagueId: 'league', memberId: 'member',
            }
            return null
        })

        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(TradeAnalyzer)) })

        expect(mocks.readPersistentCache).toHaveBeenCalledWith(latestRouteKey)
        expect(mocks.readPersistentCache).toHaveBeenCalledWith(snapshotKey)
        expect(mocks.readPersistentCache.mock.calls.some(([key]) => String(key).includes(':4:100'))).toBe(false)
        await act(async () => { renderer.unmount() })
    })
})
