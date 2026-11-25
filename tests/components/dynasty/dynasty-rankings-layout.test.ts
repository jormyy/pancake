import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DynastyHub } from '@/components/dynasty/DynastyHub'
import { table } from '@/constants/tokens'
import type { DynastyRankPlayer } from '@/lib/dynasty'

const mocks = vi.hoisted(() => ({
    useDynastyRankings: vi.fn(),
    listMounts: { count: 0 },
}))

vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: () => null }))
vi.mock('@shopify/flash-list', async () => {
    const RuntimeReact = await import('react')
    function MockFlashList({ data, renderItem, ListEmptyComponent }: {
        data?: unknown[]
        renderItem: (args: { item: unknown; index: number }) => React.ReactNode
        ListEmptyComponent?: React.ReactNode
    }) {
        RuntimeReact.useEffect(() => { mocks.listMounts.count += 1 }, [])
        return RuntimeReact.createElement(React.Fragment, null,
            data?.length ? data.map((item, index) => RuntimeReact.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent)
    }
    return { FlashList: MockFlashList }
})
vi.mock('@/components/ui', async () => {
    const RuntimeReact = await import('react')
    return {
        Button: () => null, Card: 'View', ErrorBanner: () => null, Input: 'TextInput',
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
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Image: 'Image', Modal: 'Modal', Pressable: 'Pressable',
    ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    NativeModules: {},
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web', select: <Value,>(options: { web?: Value; default?: Value }) => options.web ?? options.default },
    StyleSheet: { create: <Value,>(value: Value) => value },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({
    useLeagueContext: () => ({
        current: { id: 'member', team_name: 'My Team' },
        currentLeague: { id: 'league', scoring_settings: { points: 1 }, waiver_mode: 'faab', faab_starting_budget: 100 },
    }),
}))
vi.mock('@/hooks/use-focus-async-data', () => ({
    useFocusAsyncData: () => ({ data: [], loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('@/hooks/use-dynasty-rankings', () => ({ useDynastyRankings: mocks.useDynastyRankings }))
vi.mock('@/lib/dynasty', () => ({ getDynastyNews: vi.fn(), getMyDynastyNews: vi.fn() }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: vi.fn(async () => []), isTradingClosed: () => false }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: () => 2026 }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draftPick = {
    rankingId: 'pick-band:2027:1', playerId: null, displayName: '2026 Round 1', dynastyRank: 9001,
    rankChange: 0, isDraftPick: true, valueRange: { low: 1, high: 2 },
} as unknown as DynastyRankPlayer

function rankingsState(overrides: Record<string, unknown> = {}) {
    return {
        query: '', setQuery: vi.fn(), view: 'five-year', setView: vi.fn(), players: [], loading: false,
        refreshing: false, loadingMore: false, hasMore: false, error: null, loadMoreError: null,
        loadMore: vi.fn(), retryLoadMore: vi.fn(), refresh: vi.fn(),
        ...overrides,
    }
}

let renderer: ReactTestRenderer | undefined

beforeEach(() => {
    mocks.listMounts.count = 0
    mocks.useDynastyRankings.mockReturnValue(rankingsState())
})

afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount() })
    renderer = undefined
})

describe('dynasty rankings layout', () => {
    it('keeps one rankings list mounted while the view changes', async () => {
        await act(async () => { renderer = create(React.createElement(DynastyHub, { section: 'rankings' })) })
        expect(mocks.listMounts.count).toBe(1)
        mocks.useDynastyRankings.mockReturnValue(rankingsState({ view: 'three-year' }))
        await act(async () => { renderer!.update(React.createElement(DynastyHub, { section: 'rankings' })) })
        mocks.useDynastyRankings.mockReturnValue(rankingsState({ view: 'rookies-picks' }))
        await act(async () => { renderer!.update(React.createElement(DynastyHub, { section: 'rankings' })) })
        expect(mocks.listMounts.count).toBe(1)
    })

    it('gives the rank column room for the full rank', async () => {
        mocks.useDynastyRankings.mockReturnValue(rankingsState({ players: [draftPick] }))
        await act(async () => { renderer = create(React.createElement(DynastyHub, { section: 'rankings' })) })
        const row = renderer!.root.findByProps({ accessibilityLabel: '2026 Round 1' })
        const rankColumn = row.findAllByType('View' as React.ElementType)
            .find(node => node.props.style && Object.prototype.hasOwnProperty.call(node.props.style, 'minWidth'))!
        expect(rankColumn).toBeDefined()
        expect(rankColumn.props.style).toMatchObject({ flexShrink: 0 })
        expect(rankColumn.props.style.minWidth).toBeGreaterThanOrEqual(table.statColWidth)
        expect(rankColumn.props.style.width).toBeUndefined()
        expect(rankColumn.findAllByType('Text' as React.ElementType).map(node => String(node.props.children))).toContain('9001')
    })
})
