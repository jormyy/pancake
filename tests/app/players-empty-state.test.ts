import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlayersScreen from '@/app/(tabs)/players'

const state = vi.hoisted(() => ({ support: {} as Record<string, unknown>, search: {} as Record<string, unknown>, retry: vi.fn(), refresh: vi.fn() }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: (x: unknown) => x }, useWindowDimensions: () => ({ width: 390 }) }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('@shopify/flash-list', () => ({ FlashList: ({ data, renderItem, ListEmptyComponent, ListFooterComponent }: { data: unknown[]; renderItem: (x: unknown) => React.ReactNode; ListEmptyComponent: React.ReactNode; ListFooterComponent: React.ReactNode }) => React.createElement(React.Fragment, null, data.length ? data.map(item => renderItem({ item })) : ListEmptyComponent, ListFooterComponent) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' }, loading: false }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ memberships: [{}], current: { id: 'member' }, currentLeague: { id: 'league' }, loading: false, online: true, membershipValidated: true }) }))
vi.mock('@/hooks/use-focus-async-data', () => ({ useFocusAsyncData: () => state.support }))
vi.mock('@/hooks/use-player-support-realtime', () => ({ usePlayerSupportRealtime: () => {} }))
vi.mock('@/hooks/use-player-search', () => ({
    usePlayerSearch: () => ({ support: state.support.data, refresh: state.refresh, results: { ...state.search, loading: state.search.loading || state.support.loading, refreshing: state.search.refreshing || state.support.refreshing, isSnapshot: state.search.isSnapshot || state.support.isSnapshot, error: state.search.error ?? state.support.error }, search: { query: '', setQuery: vi.fn() }, availabilityFilter: { value: 'free_agents', setValue: vi.fn() }, position: { value: 'ALL' }, teamPicker: { selectedTeams: [] }, playing: { value: 'all' }, health: { value: 'all' }, toggles: {}, season: { value: null }, sort: { mode: 'fpts', dir: 'desc' }, activeFilterCount: 0 }),
    useVisiblePlayerRows: (rows: unknown[]) => ({ rows }), SORT_OPTIONS: [],
}))
vi.mock('@/hooks/use-quick-add', () => ({ useQuickAdd: () => ({ dropPickerPlayer: null, irModal: null }) }))
vi.mock('@/lib/tab-snapshot', () => ({ readTabSnapshot: () => undefined, writeTabSnapshot: vi.fn(), tabSnapshotScope: () => 'owner', tabSnapshotRevision: () => 'revision' }))
vi.mock('@/lib/player-availability', () => ({ loadPlayerSupport: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/pickup', () => ({ addLimitSummary: () => '' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/PlayerSearchItem', () => ({ PlayerSearchItem: 'PlayerSearchItem', playerRowGeometry: { identityHeight: 44, statHeight: 20, rowGap: 8, paddingY: 8 } }))
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: () => null }))
vi.mock('@/components/DropPlayerPickerModal', () => ({ DropPlayerPickerModal: () => null }))
vi.mock('@/components/dynasty/DynastyHub', () => ({ DynastyHub: () => null }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: () => null }))
vi.mock('@/components/ui/RetainedPanel', () => ({ RetainedPanel: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusProvider: ({ children }: React.PropsWithChildren) => children, ScreenStatusOverlay: ({ children }: React.PropsWithChildren) => children, useScreenStatusScroll: () => ({ contentStyle: (x: unknown) => x }) }))
vi.mock('@/components/ui', () => ({ FilterSelect: 'FilterSelect', MultiSelect: 'MultiSelect', Page: 'Page', PageHeader: () => null, SegmentedControl: () => null, usePageMetrics: () => ({ padX: 16, compact: true }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer | undefined
const empty = () => screen!.root.findAllByType('EmptyState' as React.ElementType)
const messages = () => empty().map(node => node.props.message)
const render = async () => { await act(async () => { if (screen) screen.update(React.createElement(PlayersScreen)); else screen = create(React.createElement(PlayersScreen)) }) }
beforeEach(() => {
    vi.clearAllMocks()
    state.support = { data: { leagueId: 'league', ownedMap: new Map(), waiverIds: new Set(), waiverClearsAt: new Map(), pendingClaimIds: new Set() }, loading: false, refreshing: false, isSnapshot: false, error: null, refresh: state.refresh, refreshIfStale: state.refresh, markStale: vi.fn() }
    state.search = { players: [], loading: false, refreshing: false, isSnapshot: false, error: null, retry: state.retry, refreshIfChanged: vi.fn() }
})
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })

it.each(['refreshing', 'isSnapshot'])('does not declare the pool empty while search %s', async field => {
    state.search[field] = true
    await render()
    expect(messages()).not.toContain('No free agents right now.')
    expect(messages()).toContain('Loading players…')
})

it.each(['loading', 'refreshing', 'isSnapshot'])('does not declare the pool empty while support %s', async field => {
    state.support[field] = true
    await render()
    expect(messages()).not.toContain('No free agents right now.')
    expect(messages()).toContain('Loading players…')
})

it('replaces a previously confirmed empty result with loading during revalidation', async () => {
    await render()
    expect(messages()).toContain('No free agents right now.')
    state.search = { ...state.search, isSnapshot: true, refreshing: true }
    await render()
    expect(messages()).not.toContain('No free agents right now.')
    expect(messages()).toContain('Loading players…')
})

it('shows a retry after support refresh fails even with an older support snapshot', async () => {
    state.support = { ...state.support, error: new Error('ownership unavailable'), isSnapshot: true }
    await render()
    const failure = empty().find(node => node.props.actionLabel === 'Retry')
    expect(failure).toBeDefined()
    expect(messages()).not.toContain('No free agents right now.')
    await act(async () => failure!.props.onAction())
    expect(state.refresh).toHaveBeenCalledOnce()
    expect(state.retry).toHaveBeenCalledOnce()
})

it('keeps a retry visible when a failed search is still marked loading', async () => {
    state.search = { ...state.search, loading: true, error: new Error('search unavailable'), isSnapshot: true }
    await render()
    expect(messages()).toContain('Players could not load.')
    expect(empty()[0].props.actionLabel).toBe('Retry')
})

it('shows the empty state only after search and support both confirm it', async () => {
    await render()
    expect(messages()).toEqual(['No free agents right now.'])
})

it('retains visible players through support refresh and exposes a failed refresh', async () => {
    state.search.players = [{ id: 'free', display_name: 'Available' }]
    await render()
    state.support = { ...state.support, refreshing: true, isSnapshot: true }
    await render()
    expect(screen!.root.findAllByType('PlayerSearchItem' as React.ElementType)).toHaveLength(1)
    state.support = { ...state.support, refreshing: false, error: new Error('support failed') }
    await render()
    expect(screen!.root.findAllByType('PlayerSearchItem' as React.ElementType)).toHaveLength(1)
    expect(screen!.root.findAllByProps({ accessibilityLabel: 'Refresh player data' })).toHaveLength(1)
    expect(messages()).not.toContain('No free agents right now.')
})

it('shows pagination progress without removing the existing players', async () => {
    state.search = { ...state.search, players: [{ id: 'free', display_name: 'Available' }], loadingMore: true }
    await render()
    expect(screen!.root.findAllByType('PlayerSearchItem' as React.ElementType)).toHaveLength(1)
    expect(screen!.root.findAllByProps({ children: 'Loading more players…' }).length).toBeGreaterThan(0)
})

it('shows the summary with saved rows during background refresh', async () => {
    state.support.data = { ...(state.support.data as object), transactionState: { waiverMode: 'faab', faabBalance: 100 } }
    state.search = { ...state.search, players: Array.from({ length: 20 }, (_, id) => ({ id: String(id), stats_season_year: 2027 })), refreshing: true }
    await render()
    const summary = screen!.root.findAllByType('Text' as React.ElementType).find(node => String(node.props.children).includes('20 players'))!
    expect(summary).toBeDefined()
    expect(summary.props.style.flat().find((style: { opacity?: number }) => style.opacity !== undefined).opacity).toBe(1)
    expect(summary.props.children).toContain('FAAB $100')
})
