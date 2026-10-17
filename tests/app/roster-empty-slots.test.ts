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
    league: { id: 'league-a', roster_size: 20, ir_slots: 2, taxi_slots: 2, status: 'active', waiver_mode: 'rolling' },
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
        currentLeague: mocks.league,
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
vi.mock('@/lib/lineup', () => ({ autoSetLineup: vi.fn(), getLineupContext: vi.fn(), getRosterSlotPlan: vi.fn() }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-17' }))
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
    ROSTER_SLOT_TAG_WIDTH: 52, RosterClaimItem: 'RosterClaimItem', RosterPickItem: 'RosterPickItem',
    RosterPlayerItem: 'RosterPlayerItem', RosterSectionBand: 'RosterSectionBand', RosterSlotTag: 'RosterSlotTag',
    TaxiPlayerItem: 'TaxiPlayerItem',
}))
vi.mock('@/components/roster/RosterPlayerSheet', () => ({ RosterPlayerSheet: 'RosterPlayerSheet' }))
vi.mock('@/components/roster/RosterTrimBanner', () => ({ RosterTrimBanner: 'RosterTrimBanner' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SLOT_PLAN = { slots: [{ slotType: 'UTIL', slotCount: 2 }, { slotType: 'PG', slotCount: 1 }, { slotType: 'BE', slotCount: 17 }], assignments: {} as Record<string, string> }

function rosterData(roster: RosterPlayer[], assignments: Record<string, string> = {}) {
    return { roster, picks: [], claims: [], avgMap: new Map(), avgStatsMap: new Map(), waiverPriority: null, slotPlan: { ...SLOT_PLAN, assignments } }
}

function slotTags(screen: ReactTestRenderer) {
    return screen.root.findAllByType('RosterSlotTag' as never).map((node) => node.props.slotType)
}

function emptySlotCounts(screen: ReactTestRenderer) {
    const counts: Record<string, number> = {}
    for (const node of screen.root.findAllByType('Text' as never)) {
        const text = node.props.children
        if (typeof text === 'string' && /^Empty \w+ slot$/.test(text)) counts[text] = (counts[text] ?? 0) + 1
    }
    return counts
}

describe('roster empty slots', () => {
    let screen: ReactTestRenderer

    beforeEach(() => {
        mocks.league.roster_size = 20
        mocks.league.ir_slots = 2
        mocks.league.taxi_slots = 2
        mocks.focusData.loading = false
        mocks.focusData.data = rosterData([])
    })

    afterEach(() => {
        act(() => screen.unmount())
    })

    it('keeps every active, IR and taxi slot visible when the roster is completely empty', () => {
        act(() => { screen = create(React.createElement(RosterScreen)) })

        expect(emptySlotCounts(screen)).toEqual({
            'Empty PG slot': 1, 'Empty UTIL slot': 2, 'Empty bench slot': 17, 'Empty IR slot': 2, 'Empty taxi slot': 2,
        })
        expect(slotTags(screen)).toEqual(['PG', 'UTIL', 'UTIL', ...Array(17).fill('BE'), 'IR', 'IR', 'TX', 'TX'])
        const prompt = screen.root.findByType('EmptyState' as never)
        expect(prompt.props).toMatchObject({ message: 'Your roster is empty', actionLabel: 'Browse Players' })
        act(() => prompt.props.onAction())
        expect(mocks.push).toHaveBeenCalledWith('/players')
    })

    it('labels starters by their lineup slot and keeps unassigned players on the bench', () => {
        const player = (id: string) => ({
            id: `roster-${id}`, is_on_ir: false, is_on_taxi: false, acquired_via: 'draft',
            players: { id, display_name: `Player ${id}`, position: 'PG', eligible_positions: ['PG'],
                nba_team: 'BOS', injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 1 },
        }) as RosterPlayer
        mocks.focusData.data = rosterData([player('one'), player('two')], { one: 'UTIL' })
        act(() => { screen = create(React.createElement(RosterScreen)) })

        const rows = screen.root.findAllByType('RosterPlayerItem' as never).map((node) => [node.props.item.players.id, node.props.slotType])
        expect(rows).toEqual([['one', 'UTIL'], ['two', 'BE']])
        expect(emptySlotCounts(screen)).toEqual({
            'Empty PG slot': 1, 'Empty UTIL slot': 1, 'Empty bench slot': 16, 'Empty IR slot': 2, 'Empty taxi slot': 2,
        })
        const bands = screen.root.findAllByType('RosterSectionBand' as React.ElementType).map((node) => node.props.label)
        expect(bands.slice(0, 2)).toEqual(['Starters', 'Bench'])
        expect(screen.root.findAllByType('EmptyState' as never)).toHaveLength(0)
    })

    it('does not flash empty slots while the first roster load is pending', () => {
        mocks.focusData.loading = true
        mocks.focusData.data = null
        act(() => { screen = create(React.createElement(RosterScreen)) })

        expect(emptySlotCounts(screen)).toEqual({})
    })
    it('omits empty zero-capacity roster sections', () => {
        mocks.league.roster_size = 0
        mocks.league.ir_slots = 0
        mocks.league.taxi_slots = 0
        mocks.focusData.data = { ...rosterData([]), slotPlan: { slots: [], assignments: {} } }
        act(() => { screen = create(React.createElement(RosterScreen)) })
        expect(emptySlotCounts(screen)).toEqual({})
        expect(screen.root.findAllByType('RosterSectionBand' as React.ElementType).filter((node) => ['Starters', 'Bench', 'Injured reserve', 'Taxi squad'].includes(node.props.label))).toHaveLength(0)
    })
})
