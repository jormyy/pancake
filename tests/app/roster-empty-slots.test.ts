import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import type { RosterPlayer } from '@/lib/roster'

type ListProps = {
    data: unknown[]
    renderItem: (info: { item: unknown; index: number }) => React.ReactNode
    keyExtractor: (item: unknown) => string
    ListHeaderComponent?: React.ReactNode
}

const mocks = vi.hoisted(() => ({
    focusData: {
        data: null as null | Record<string, unknown>,
        loading: false,
        error: null,
        refresh: vi.fn(),
    },
    push: vi.fn(),
}))

vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('@shopify/flash-list', async () => {
    const { createElement, Fragment, forwardRef } = await import('react')
    return {
        FlashList: forwardRef(function FlashList({ data, renderItem, keyExtractor, ListHeaderComponent }: ListProps, _ref) {
            return createElement('FlashList', null, ListHeaderComponent ?? null,
                data.map((item, index) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))))
        }),
    }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push, setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('expo-haptics', () => ({}))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user-a' } }) }))
vi.mock('@/contexts/league-context', () => ({
    useLeagueContext: () => ({
        current: { id: 'member-a', team_name: 'Team A' },
        currentLeague: { id: 'league-a', roster_size: 20, ir_slots: 2, taxi_slots: 2, status: 'active', waiver_mode: 'rolling' },
        loading: false,
        membershipStatus: 'available',
    }),
}))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/use-focus-async-data', () => ({ useFocusAsyncData: () => mocks.focusData }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/roster', () => ({
    getRoster: vi.fn(), toggleIR: vi.fn(), toggleTaxi: vi.fn(), dropPlayer: vi.fn(), isIREligible: () => false,
}))
vi.mock('@/lib/trades', () => ({ getPicksForMember: vi.fn() }))
vi.mock('@/lib/waivers', () => ({
    getMyWaiverClaims: vi.fn(), cancelWaiverClaim: vi.fn(), editWaiverClaim: vi.fn(),
    reorderWaiverClaim: vi.fn(), getMyWaiverPriority: vi.fn(),
}))
vi.mock('@/lib/roster-stats', () => ({ EMPTY_AVG_MAP: new Map(), EMPTY_STATS_MAP: new Map(), getRosterStatsMaps: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }),
    reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn(),
}))
vi.mock('@/lib/lineup', () => ({ autoSetLineup: vi.fn(), getLineupContext: vi.fn() }))
vi.mock('@/lib/league', () => ({ isTradingClosed: () => false }))
vi.mock('@/lib/format', () => ({
    countLabel: (count: number, noun: string) => `${count} ${noun}`,
    formatPoints: String,
    playerHeadshotUrl: () => null,
}))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/ui', () => ({
    Button: 'Button', ErrorBanner: 'ErrorBanner', Page: 'Page', PageHeader: 'PageHeader',
    usePageMetrics: () => ({ padX: 16, usableWidth: 358 }),
}))
vi.mock('@/components/roster/RosterItems', () => ({
    RosterClaimItem: 'RosterClaimItem', RosterPickItem: 'RosterPickItem', RosterPlayerItem: 'RosterPlayerItem',
    RosterSectionBand: 'RosterSectionBand', TaxiPlayerItem: 'TaxiPlayerItem',
}))
vi.mock('@/components/roster/RosterPlayerSheet', () => ({ RosterPlayerSheet: 'RosterPlayerSheet' }))
vi.mock('@/components/roster/RosterTrimBanner', () => ({ RosterTrimBanner: 'RosterTrimBanner' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function rosterData(roster: RosterPlayer[]) {
    return { roster, picks: [], claims: [], avgMap: new Map(), avgStatsMap: new Map(), waiverPriority: null }
}

function emptySlotCounts(screen: ReactTestRenderer) {
    const counts: Record<string, number> = {}
    for (const node of screen.root.findAllByType('Text' as never)) {
        const text = node.props.children
        if (typeof text === 'string' && /^Empty (roster|IR|taxi) slot$/.test(text)) counts[text] = (counts[text] ?? 0) + 1
    }
    return counts
}

describe('roster empty slots', () => {
    let screen: ReactTestRenderer

    beforeEach(() => {
        mocks.focusData.loading = false
        mocks.focusData.data = rosterData([])
    })

    afterEach(() => {
        act(() => screen.unmount())
    })

    it('keeps every active, IR and taxi slot visible when the roster is completely empty', () => {
        act(() => { screen = create(React.createElement(RosterScreen)) })

        expect(emptySlotCounts(screen)).toEqual({ 'Empty roster slot': 20, 'Empty IR slot': 2, 'Empty taxi slot': 2 })
        const prompt = screen.root.findByType('EmptyState' as never)
        expect(prompt.props).toMatchObject({ message: 'Your roster is empty', actionLabel: 'Browse Players' })
        act(() => prompt.props.onAction())
        expect(mocks.push).toHaveBeenCalledWith('/players')
    })

    it('shows the remaining open slots without the empty prompt once a player is rostered', () => {
        mocks.focusData.data = rosterData([{
            id: 'roster-one', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft',
            players: { id: 'player-one', display_name: 'Player One', position: 'PG', eligible_positions: ['PG'],
                nba_team: 'BOS', injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 1 },
        } as RosterPlayer])
        act(() => { screen = create(React.createElement(RosterScreen)) })

        expect(emptySlotCounts(screen)).toEqual({ 'Empty roster slot': 19, 'Empty IR slot': 2, 'Empty taxi slot': 2 })
        expect(screen.root.findAllByType('EmptyState' as never)).toHaveLength(0)
    })

    it('does not flash empty slots while the first roster load is pending', () => {
        mocks.focusData.loading = true
        mocks.focusData.data = null
        act(() => { screen = create(React.createElement(RosterScreen)) })

        expect(emptySlotCounts(screen)).toEqual({})
    })
})
