import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import type { RosterPlayer } from '@/lib/roster'
import { subscribeToTableChanges } from '@/lib/realtime'
import { setLeagueChangesConnected } from '@/lib/league-changes'
import { activateRosterPlayerWithOverflow, toggleIR, toggleTaxi } from '@/lib/roster'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'
import { confirmAction, showAlert } from '@/lib/alert'
import { autoSetLineup, getLineupContext } from '@/lib/lineup'

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
    online: true, eligible: false, usableWidth: 358,
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
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push, setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Medium: 'Medium' } }))
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
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => mocks.online }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ ...mocks.focusData,
    data: mocks.focusData.data ? { ...mocks.focusData.data, avgMap: {}, avgStatsMap: {} } : undefined,
}) }))
vi.mock('@/hooks/use-focus-async-data', () => ({ useFocusAsyncData: () => mocks.focusData }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/roster', () => ({
    getRoster: vi.fn(), toggleIR: vi.fn(), toggleTaxi: vi.fn(), dropPlayer: vi.fn(), isIREligible: () => mocks.eligible,
    activateRosterPlayerWithOverflow: vi.fn(),
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
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: vi.fn(), invalidateSeasonCache: vi.fn() }))
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
    usePageMetrics: () => ({ padX: 16, usableWidth: mocks.usableWidth }),
}))
vi.mock('@/components/roster/RosterItems', () => ({
    ROSTER_SLOT_TAG_WIDTH: 52, RosterClaimItem: 'RosterClaimItem', RosterPickItem: 'RosterPickItem',
    RosterPlayerItem: 'RosterPlayerItem', RosterSectionBand: 'RosterSectionBand', RosterSlotTag: 'RosterSlotTag',
    TaxiPlayerItem: 'TaxiPlayerItem',
}))
vi.mock('@/components/roster/RosterPlayerSheet', () => ({ RosterPlayerSheet: 'RosterPlayerSheet' }))
vi.mock('@/components/roster/RosterTrimBanner', () => ({ RosterTrimBanner: 'RosterTrimBanner' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/ActivationOverflowModal', () => ({ ActivationOverflowModal: 'ActivationOverflowModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))

vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: 'IRResolutionModal' }))
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
        vi.clearAllMocks()
        mocks.online = true
        mocks.eligible = false
        mocks.usableWidth = 358
        vi.mocked(getRosterStatusChangeLockMessage).mockResolvedValue(null)
        vi.mocked(activateRosterPlayerWithOverflow).mockResolvedValue(undefined)
        vi.mocked(subscribeToTableChanges).mockClear()
        mocks.focusData.refresh.mockReset()
        mocks.league.status = 'active'
        mocks.league.roster_size = 20
        mocks.league.ir_slots = 2
        mocks.league.taxi_slots = 2
        mocks.focusData.loading = false
        mocks.focusData.data = rosterData([])
    })

    afterEach(() => {
        act(() => screen.unmount())
        setLeagueChangesConnected('league-a', false)
        vi.useRealTimers()
    })

    it.each([358, 1600])('keeps offseason activation and permits IR repair while over the active limit at width %s', async width => {
        mocks.eligible = true
        mocks.usableWidth = width
        mocks.league.status = 'offseason'
        mocks.league.roster_size = 1
        const active = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'], injury_status: 'Out' } } as RosterPlayer
        const reserve = { ...active, id: 'reserve', is_on_ir: true, players: { ...active.players, id: 'reserve-player', display_name: 'Reserve' } }
        mocks.focusData.data = rosterData([active, { ...active, id: 'extra' }, reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        expect(screen.root.findByType('RosterTrimBanner' as React.ElementType).props.irAvailable).toBe(true)
        if (width === 358) {
            const rows = screen.root.findAllByType('RosterPlayerItem' as React.ElementType)
            expect(rows.find(row => row.props.item.id === 'active')!.props.allowIR).toBe(false)
            await act(async () => rows.find(row => row.props.item.id === 'active')!.props.onPress(active))
        } else {
            expect(screen.root.findAllByProps({ accessibilityLabel: 'Move to IR Active' })).toHaveLength(0)
            expect(screen.root.findAllByProps({ accessibilityLabel: 'Activate Reserve' })).toHaveLength(1)
            await act(async () => screen.root.findAllByProps({ accessibilityLabel: 'Open Active' })[0].props.onPress())
        }
        expect(screen.root.findByType('RosterPlayerSheet' as React.ElementType).props.actions.some((action: { label: string }) => action.label === 'Move to IR')).toBe(false)
    })

    it.each(['onToday', 'onWholeWeek', 'onRestOfSeason'] as const)('reports partial failures for %s', async action => {
        vi.mocked(getLineupContext).mockResolvedValue({ seasonId: 'season', weekNumber: 1, seasonYear: 2026, today: '2026-10-24' })
        vi.mocked(autoSetLineup).mockResolvedValue({ dates: 2, optimized: 1, failed: 1, skipped: 0, results: [] })
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        await act(async () => { screen.root.findByType('AutoSetModal' as React.ElementType).props[action](); await Promise.resolve() })
        expect(showAlert).toHaveBeenCalledExactlyOnceWith('Lineup partly optimized', 'Optimized 1 of 2 dates; 1 failed.')
    })

    it.each(['onToday', 'onWholeWeek', 'onRestOfSeason'] as const)('reports no remaining dates for %s', async action => {
        vi.mocked(getLineupContext).mockResolvedValue({ seasonId: 'season', weekNumber: 1, seasonYear: 2026, today: '2026-10-24' })
        vi.mocked(autoSetLineup).mockResolvedValue({ dates: 0, optimized: 0, failed: 0, skipped: 0, results: [] })
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        await act(async () => { screen.root.findByType('AutoSetModal' as React.ElementType).props[action](); await Promise.resolve() })
        expect(showAlert).toHaveBeenCalledExactlyOnceWith(action === 'onRestOfSeason' ? 'Season is over' : 'No remaining dates',
            action === 'onRestOfSeason' ? 'There are no remaining dates this season to optimize.'
                : 'There are no remaining dates in this selection to optimize.', 'info')
    })

    it('keeps the pending claims jump target at least 44px high', async () => {
        mocks.focusData.data = { ...rosterData([]), claims: [{ id: 'claim', status: 'pending' }] }
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const header = screen.root.findByType('PageHeader' as React.ElementType)
        const pill = React.Children.toArray(header.props.actions.props.children)[0] as React.ReactElement<{ count: number }>
        expect(pill.props.count).toBe(1)
        let pillScreen!: ReactTestRenderer
        await act(async () => { pillScreen = create(pill) })
        const target = pillScreen.root.findByProps({ accessibilityLabel: '1 pending claims, open Waivers' })
        expect([target.props.style].flat().some((style: { minHeight?: number }) => (style?.minHeight ?? 0) >= 44)).toBe(true)
        await act(async () => pillScreen.unmount())
    })

    it('names the auto-set options consistently with Home', async () => {
        mocks.focusData.data = rosterData([{ id: 'roster', is_on_ir: false, is_on_taxi: false, players: { id: 'player', display_name: 'Player', position: 'PG', eligible_positions: ['PG'], years_exp: 1 } } as RosterPlayer])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const actions = screen.root.findByType('PageHeader' as React.ElementType).props.actions
        const button = React.Children.toArray(actions.props.children).find(child => React.isValidElement<{ accessibilityLabel?: string }>(child)
            && child.props.accessibilityLabel === 'Open auto-set lineup options') as React.ReactElement<{ accessibilityLabel: string; title: string; onPress: () => void }>
        expect(button.props.accessibilityLabel).toBe('Open auto-set lineup options')
        expect(button.props.title).toBe('Auto-set')
        await act(async () => button.props.onPress())
        expect(screen.root.findByType('AutoSetModal' as React.ElementType).props.visible).toBe(true)
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

    it.each([
        ['ir', 'drop'], ['ir', 'ir'], ['taxi', 'drop'], ['taxi', 'ir'],
    ] as const)('activates from %s by making room with %s in one roster change', async (source, action) => {
        mocks.league.roster_size = 1
        const reserve = { id: 'reserve', is_on_ir: source === 'ir', is_on_taxi: source === 'taxi',
            players: { id: 'reserve-player', display_name: 'Reserve', eligible_positions: ['PG'] } } as RosterPlayer
        const active = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([active, reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const row = screen.root.findAllByType((source === 'ir' ? 'RosterPlayerItem' : 'TaxiPlayerItem') as React.ElementType)
            .find(node => node.props.item.id === 'reserve')!
        await act(async () => row.props[source === 'ir' ? 'onToggleIR' : 'onToggleTaxi'](reserve))
        const picker = () => screen.root.findByType('ActivationOverflowModal' as React.ElementType)
        expect(picker().props.pending).toEqual({ rosterPlayerId: 'reserve', source })
        expect(picker().props.myLineup.bench.map((player: { rosterPlayerId: string }) => player.rosterPlayerId)).toEqual(['active'])
        expect(activateRosterPlayerWithOverflow).not.toHaveBeenCalled()
        vi.mocked(getRosterStatusChangeLockMessage).mockClear()
        await act(async () => picker().props[action === 'drop' ? 'onDrop' : 'onMoveToIR']('active'))
        expect(activateRosterPlayerWithOverflow).not.toHaveBeenCalled()
        expect(confirmAction).toHaveBeenCalledOnce()
        const confirmation = vi.mocked(confirmAction).mock.calls[0]
        expect(confirmation[1]).toContain('Active')
        expect(confirmation[1]).toContain('Reserve')
        if (source === 'taxi') expect(confirmation[1]).toContain('cannot return to your team’s taxi')
        await act(async () => confirmation[2]())
        expect(getRosterStatusChangeLockMessage).toHaveBeenCalledExactlyOnceWith(active)
        expect(activateRosterPlayerWithOverflow).toHaveBeenCalledExactlyOnceWith('reserve', source, 'active', action)
        expect(toggleIR).not.toHaveBeenCalled()
        expect(toggleTaxi).not.toHaveBeenCalled()
        expect(mocks.focusData.refresh).toHaveBeenCalledOnce()
        expect(picker().props.pending).toBeNull()
    })

    it('explains the waiver run when confirming a drop', async () => {
        const player = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([player])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        await act(async () => screen.root.findByType('RosterPlayerItem' as React.ElementType).props.onLongPress(player))
        expect(confirmAction).toHaveBeenCalledWith('Drop Active?', 'They will stay on waivers until the first league-local midnight after 48 hours.', expect.any(Function), 'Drop')
    })

    it.each(['active', 'offseason'])('uses real IR occupancy and blocks offseason IR moves in %s', async status => {
        mocks.league.status = status
        mocks.league.ir_slots = 1
        const reserve = { id: 'injured', is_on_ir: true, is_on_taxi: false,
            players: { id: 'injured-player', display_name: 'Injured', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const picker = screen.root.findByType('ActivationOverflowModal' as React.ElementType)
        expect.soft(picker.props.myLineup.ir.map((player: { rosterPlayerId: string }) => player.rosterPlayerId)).toEqual(['injured'])
        expect(picker.props.irSlots).toBe(1)
        expect(picker.props.allowIR).toBe(status !== 'offseason')
    })

    it('keeps the activation choice open if a selected player becomes locked', async () => {
        mocks.league.roster_size = 1
        const reserve = { id: 'reserve', is_on_ir: true, is_on_taxi: false,
            players: { id: 'reserve-player', display_name: 'Reserve', eligible_positions: ['PG'] } } as RosterPlayer
        const active = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([active, reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const row = screen.root.findAllByType('RosterPlayerItem' as React.ElementType).find(node => node.props.item.id === 'reserve')!
        await act(async () => row.props.onToggleIR(reserve))
        vi.mocked(getRosterStatusChangeLockMessage).mockImplementation(async item => item?.id === 'active' ? 'The game has started.' : null)
        const picker = () => screen.root.findByType('ActivationOverflowModal' as React.ElementType)
        await act(async () => picker().props.onDrop('active'))
        await act(async () => vi.mocked(confirmAction).mock.calls[0]?.[2]())
        expect(activateRosterPlayerWithOverflow).not.toHaveBeenCalled()
        expect(showAlert).toHaveBeenCalledWith('Roster locked', 'The game has started.')
        expect(picker().props.pending).not.toBeNull()
        await act(async () => picker().props.onCancel())
        expect(picker().props.pending).toBeNull()
    })

    it('does not activate after leaving the roster during the final lock check', async () => {
        mocks.league.roster_size = 1
        const reserve = { id: 'reserve', is_on_ir: true, is_on_taxi: false,
            players: { id: 'reserve-player', display_name: 'Reserve', eligible_positions: ['PG'] } } as RosterPlayer
        const active = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([active, reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const row = screen.root.findAllByType('RosterPlayerItem' as React.ElementType).find(node => node.props.item.id === 'reserve')!
        await act(async () => row.props.onToggleIR(reserve))
        let release!: (value: null) => void
        vi.mocked(getRosterStatusChangeLockMessage).mockImplementation(async item => item?.id === 'active'
            ? new Promise<null>(resolve => { release = resolve }) : null)
        const picker = screen.root.findByType('ActivationOverflowModal' as React.ElementType)
        await act(async () => picker.props.onDrop('active'))
        await act(async () => { void vi.mocked(confirmAction).mock.calls[0]?.[2]() })
        await act(async () => screen.unmount())
        await act(async () => release(null))
        expect(activateRosterPlayerWithOverflow).not.toHaveBeenCalled()
    })

    it('reports an offline overflow choice without sending or opening confirmation', async () => {
        mocks.league.roster_size = 1
        const reserve = { id: 'reserve', is_on_ir: true, is_on_taxi: false,
            players: { id: 'reserve-player', display_name: 'Reserve', eligible_positions: ['PG'] } } as RosterPlayer
        const active = { id: 'active', is_on_ir: false, is_on_taxi: false,
            players: { id: 'active-player', display_name: 'Active', eligible_positions: ['PG'] } } as RosterPlayer
        mocks.focusData.data = rosterData([active, reserve])
        await act(async () => { screen = create(React.createElement(RosterScreen)) })
        const row = screen.root.findAllByType('RosterPlayerItem' as React.ElementType).find(node => node.props.item.id === 'reserve')!
        await act(async () => row.props.onToggleIR(reserve))
        mocks.online = false
        await act(async () => screen.update(React.createElement(RosterScreen)))
        await act(async () => screen.root.findByType('ActivationOverflowModal' as React.ElementType).props.onDrop('active'))
        expect(showAlert).toHaveBeenCalledWith('Offline', expect.stringContaining('connection'))
        expect(confirmAction).not.toHaveBeenCalled()
        expect(activateRosterPlayerWithOverflow).not.toHaveBeenCalled()
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
