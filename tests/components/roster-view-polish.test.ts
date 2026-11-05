import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import { ClaimsPill } from '@/components/roster/ClaimsPill'
import type { RosterView } from '@/lib/cache/view-types'
import { WaiversSection } from '@/components/waivers/WaiversSection'
import { memberTransactionState } from '@/tests/helpers/fixtures'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { RosterClaimItem } from '@/components/roster/RosterItems'

const mocks = vi.hoisted(() => ({ roster: vi.fn(), claims: vi.fn(), post: vi.fn(), push: vi.fn(), cancel: vi.fn(), edit: vi.fn(), reorder: vi.fn(), viewRead: vi.fn(), width: 358, online: true,
    view: { data: null as RosterView | null, loading: false, refreshing: false, error: null, refresh: vi.fn() },
}))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: (...args: unknown[]) => { mocks.viewRead(...args); return mocks.view } }))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return { useIsFocused: () => true, useFocusEffect: (callback: React.EffectCallback) => ReactModule.useEffect(callback, [callback]) }
})
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles },
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push, setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: async () => null }))
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Medium: 'Medium' } }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    current: { id: 'member', team_name: 'Team' }, currentLeague: { id: 'league', status: 'active', waiver_mode: 'faab' }, loading: false,
}) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => mocks.online }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.roster, isIREligible: () => false }))
vi.mock('@/lib/trades', () => ({ getPicksForMember: async () => [] }))
vi.mock('@/lib/waivers', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/waivers')>(), getMyWaiverClaims: mocks.claims, getMyWaiverPriority: async () => 6, cancelWaiverClaim: mocks.cancel, editWaiverClaim: mocks.edit, reorderWaiverClaim: mocks.reorder,
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.post }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/roster-stats', () => ({ EMPTY_AVG_MAP: new Map(), EMPTY_STATS_MAP: new Map(), getRosterStatsMaps: async () => ({ avgMap: new Map(), avgStatsMap: new Map() }) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))
vi.mock('@/lib/lineup', () => ({ getRosterSlotPlan: async () => ({ slots: [], assignments: {} }) }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: async () => 'season' }))
vi.mock('@/lib/league', () => ({ isTradingClosed: () => false, getMemberTransactionState: async () => memberTransactionState({ faabBalance: 100, weeklyAddLimit: 2, weeklyAddCount: 0 }) }))
vi.mock('@/lib/format', () => ({ countLabel: String, formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/components/ui', async () => ({ Page: 'Page', PageHeader: 'PageHeader', Button: (await import('@/components/ui/Button')).Button, Card: (await import('@/components/ui/Card')).Card, usePageMetrics: () => ({ padX: 16, usableWidth: mocks.width }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/roster/RosterItems', async importOriginal => {
    const actual = await importOriginal<typeof import('@/components/roster/RosterItems')>()
    return {
        ...actual, RosterClaimItem: (props: React.ComponentProps<typeof actual.RosterClaimItem>) => React.createElement(actual.RosterClaimItem, props),
        RosterSectionBand: 'RosterSectionBand', RosterSlotTag: 'RosterSlotTag', ROSTER_SLOT_TAG_WIDTH: 52,
    }
})
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('View', props, children),
}))
vi.mock('@/components/roster/RosterPlayerSheet', () => ({ RosterPlayerSheet: 'RosterPlayerSheet' }))
vi.mock('@/components/roster/RosterTrimBanner', () => ({ RosterTrimBanner: 'RosterTrimBanner' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/ActivationOverflowModal', () => ({ ActivationOverflowModal: 'ActivationOverflowModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge', InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: 'IRResolutionModal' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const claim = { id: 'claim', playerId: 'player', playerName: 'Player', playerNbaId: null, dropPlayerId: null, dropPlayerName: null, dropPlayerNbaId: null, status: 'pending', processDate: '2099-10-28', submittedAt: '2026-10-27', priorityAtSubmission: 6, bidAmount: 0, claimOrder: 1, failureReason: null }
beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    setSessionOwner('user')
    clearSessionCaches()
    mocks.roster.mockResolvedValue([])
    mocks.claims.mockResolvedValue([claim])
    mocks.post.mockResolvedValue({ claimOrder: 1 })
    mocks.width = 358
    mocks.online = true
    mocks.view.refresh.mockResolvedValue(undefined)
    mocks.cancel.mockResolvedValue(undefined)
    mocks.edit.mockResolvedValue(undefined)
    mocks.reorder.mockResolvedValue(undefined)
    mocks.view.data = {
        context: { leagueId: 'league', memberId: 'member', seasonId: 'season', seasonYear: 2027, weekNumber: 2, today: '2026-10-27', version: 1, stale: false },
        roster: [], picks: [], claims: [claim], avgMap: {}, avgStatsMap: {}, waiverPriority: 6, faabBalance: 100,
        slotPlan: { slots: [{ slotType: 'PG', slotCount: 1 }, { slotType: 'BE', slotCount: 19 }], assignments: {} },
        transactionState: memberTransactionState({ faabBalance: 100, weeklyAddLimit: 2, weeklyAddCount: 0 }), taxiExitPlayerIds: [],
    }
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it.each([358, 1600])('keeps claims in the pill and out of the roster at width %s', async width => {
    mocks.width = width
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    expect(mocks.viewRead).toHaveBeenCalledWith(expect.objectContaining({ screen: 'roster', accountId: 'user', memberId: 'member', leagueId: 'league' }))
    expect(mocks.roster).not.toHaveBeenCalled()
    expect(mocks.claims).not.toHaveBeenCalled()
    expect(screen.root.findAllByType(RosterClaimItem)).toHaveLength(0)
    const actions = screen.root.findByType('PageHeader' as React.ElementType).props.actions
    const pill = React.Children.toArray(actions.props.children).find(child => React.isValidElement(child) && child.type === ClaimsPill) as React.ReactElement<{ count: number }>
    expect(pill.props.count).toBe(1)
})

it('keeps the Waivers copy and touch target sizes with the shared view', async () => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    expect(mocks.viewRead).toHaveBeenCalledWith(expect.objectContaining({ screen: 'roster', accountId: 'user', params: expect.objectContaining({ section: 'waivers' }) }), true)
    expect(mocks.claims).not.toHaveBeenCalled()
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join(' ')
    expect(text).toContain('Available FAAB $100')
    expect(text).toContain('Priority #6')
    expect(text).toContain('Next run ')
    expect(text).toContain('Pickups 0/2 this week')
    expect(text).not.toMatch(/Dropped players wait|Bids stay private|Higher bids go first|Claim order decides|Successful pickups|scoring week/)
    const targets = screen.root.findAllByType(Button).flatMap(button => button.findAllByType('Pressable' as React.ElementType))
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
        const style = Object.assign({}, ...target.props.style({}).flat(Infinity).filter(Boolean))
        expect(style.minHeight).toBeGreaterThanOrEqual(44)
    }
    expect(targets.find(target => target.props.accessibilityLabel === 'Find a player to claim')?.props.style({}).flat(Infinity)).toContainEqual({ width: '100%' })
})

it.each(['cancel', 'edit', 'reorder'])('refreshes the shared Waivers view after %s', async operation => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const row = screen.root.findByType(RosterClaimItem)
    await act(async () => {
        if (operation === 'cancel') row.props.onCancel('claim')
        if (operation === 'edit') await row.props.onEditBid(claim, 5)
        if (operation === 'reorder') row.props.onReorder('claim', 'up')
    })
    const mutation = operation === 'cancel' ? mocks.cancel : operation === 'edit' ? mocks.edit : mocks.reorder
    expect(mutation).toHaveBeenCalledOnce()
    expect(mocks.view.refresh).toHaveBeenCalledExactlyOnceWith(true)
    expect(mocks.roster).not.toHaveBeenCalled()
    expect(mocks.claims).not.toHaveBeenCalled()
})

it('shows pending and finished Waivers claims without a history control', async () => {
    mocks.view.data!.claims = [claim, { ...claim, id: 'finished', playerName: 'Finished Player', status: 'failed_priority' }]
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const text = JSON.stringify(screen.toJSON())
    expect(text).toContain('Pending claims (1)')
    expect(text).toContain('Recent results')
    expect(text).toContain('Finished Player')
    expect(text).toContain('Failed: outbid')
    expect(screen.root.findAllByType(RosterClaimItem)).toHaveLength(2)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Cancel claim for Player' }).length).toBeGreaterThan(0)
    expect(screen.root.findAllByProps({ accessibilityLabel: 'What happened?' })).toHaveLength(0)
    expect(text).not.toContain('What happened?')
})

it('keeps offline claim actions available for the merged mutation queue', async () => {
    mocks.online = false
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const row = screen.root.findByType(RosterClaimItem)
    expect(row.props.cancellingId).toBeNull()
    expect(JSON.stringify(screen.toJSON())).toContain('Offline. Changes stay pending until you reconnect.')
    await act(async () => { row.props.onCancel('claim') })
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('claim', 'member')
    expect(mocks.view.refresh).toHaveBeenCalledExactlyOnceWith(true)
})

it('uses shared section borders around the pending heading and each claim', async () => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const { borderWidth, colors } = await import('@/constants/tokens')
    const heading = screen.root.findByProps({ accessibilityLabel: 'Pending claims (1)' })
    expect(heading.props.style).toContainEqual(expect.objectContaining({ borderBottomWidth: borderWidth.thin, borderBottomColor: colors.borderLight }))
    const section = screen.root.findAllByType(Card).find(card => card.findAllByProps({ accessibilityLabel: 'Pending claims (1)' }).length > 0)!
    expect(section.props).toMatchObject({ padding: 'none', elevated: 'none', style: { overflow: 'hidden' } })
    expect(screen.root.findByType(RosterClaimItem).parent!.props.style).toEqual(expect.objectContaining({ borderBottomWidth: borderWidth.thin, borderBottomColor: colors.separator }))
})

it('shows one lock in roster table player metadata', async () => {
    const { rosterPlayer } = await import('@/tests/helpers/fixtures')
    mocks.width = 1600
    mocks.view.data!.roster = [rosterPlayer({ assetLocks: [{ assetKind: 'player', assetId: 'player-a', sourceKind: 'trade', sourceId: 'hidden-id', reason: 'Locked by trade hidden-id. Resolve the trade.' }] })]
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Locked by a pending trade' })).toHaveLength(1)
    expect(screen.root.findAllByType('Text' as React.ElementType).map(node => typeof node.props.children === 'string' ? node.props.children : '').join(' ')).not.toContain('hidden-id')
})

it.each(['start', 'bench', null] as const)('shows the today pin on wide Roster rows: %s', async pin => {
    mocks.width = 1600
    mocks.view.data!.roster = [{
        id: 'roster', lineupPin: pin, acquired_via: 'draft', is_on_ir: false, is_on_taxi: false,
        players: { id: 'player', display_name: 'Player', nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'],
            injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 2 },
    }]
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    const labels = screen.root.findAllByType('View' as React.ElementType).map(node => node.props.accessibilityLabel)
    expect(labels.includes('Pinned to start')).toBe(pin === 'start')
    expect(labels.includes('Pinned to bench')).toBe(pin === 'bench')
})
