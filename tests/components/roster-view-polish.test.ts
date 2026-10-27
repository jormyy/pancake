import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import { ClaimsPill } from '@/components/roster/ClaimsPill'
import type { RosterView } from '@/lib/cache/view-types'
import { WaiversSection } from '@/components/waivers/WaiversSection'
import { memberTransactionState } from '@/tests/helpers/fixtures'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

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
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
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
vi.mock('@/lib/format', () => ({ countLabel: String }))
vi.mock('@/components/ui', () => ({ Page: 'Page', PageHeader: 'PageHeader', Button: 'Button', usePageMetrics: () => ({ padX: 16, usableWidth: mocks.width }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/NoLeagueState', () => ({ NoLeagueState: 'NoLeagueState' }))
vi.mock('@/components/roster/RosterItems', () => ({
    RosterClaimItem: 'RosterClaimItem', RosterSectionBand: 'RosterSectionBand', RosterSlotTag: 'RosterSlotTag', ROSTER_SLOT_TAG_WIDTH: 52,
}))
vi.mock('@/components/roster/RosterPlayerSheet', () => ({ RosterPlayerSheet: 'RosterPlayerSheet' }))
vi.mock('@/components/roster/RosterTrimBanner', () => ({ RosterTrimBanner: 'RosterTrimBanner' }))
vi.mock('@/components/AutoSetModal', () => ({ AutoSetModal: 'AutoSetModal' }))
vi.mock('@/components/ActivationOverflowModal', () => ({ ActivationOverflowModal: 'ActivationOverflowModal' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
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
    expect(screen.root.findAllByType('RosterClaimItem' as React.ElementType)).toHaveLength(0)
    const actions = screen.root.findByType('PageHeader' as React.ElementType).props.actions
    const pill = React.Children.toArray(actions.props.children).find(child => React.isValidElement(child) && child.type === ClaimsPill) as React.ReactElement<{ count: number }>
    expect(pill.props.count).toBe(1)
})

it('keeps the Waivers copy and touch target sizes with the shared view', async () => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    expect(mocks.viewRead).toHaveBeenCalledWith(expect.objectContaining({ screen: 'roster', accountId: 'user', params: expect.objectContaining({ section: 'waivers' }) }), true)
    expect(mocks.claims).not.toHaveBeenCalled()
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join(' ')
    expect(text).toContain('Available FAAB $100 · Priority #6')
    expect(text).toContain('Next run ')
    expect(text).toContain('Pickups 0/2 this week')
    expect(text).not.toMatch(/Dropped players wait|Bids stay private|Higher bids go first|Claim order decides|Successful pickups|scoring week/)
    for (const target of screen.root.findAllByType('Pressable' as React.ElementType)) {
        expect(target.props.style.minHeight).toBeGreaterThanOrEqual(44)
        expect(target.props.style.minWidth).toBeGreaterThanOrEqual(44)
    }
})

it.each(['cancel', 'edit', 'reorder'])('refreshes the shared Waivers view after %s', async operation => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const row = screen.root.findByType('RosterClaimItem' as React.ElementType)
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

it('opens claim history from the Waivers location', async () => {
    mocks.view.data!.claims = [{ ...claim, status: 'failed_priority' }]
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    await act(async () => { screen.root.findByType('RosterClaimItem' as React.ElementType).props.onTimeline() })
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/timeline', params: { memberId: 'member', entityId: 'claim', filter: 'claims' } })
})

it('keeps offline claim actions available for the merged mutation queue', async () => {
    mocks.online = false
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const row = screen.root.findByType('RosterClaimItem' as React.ElementType)
    expect(row.props.cancellingId).toBeNull()
    expect(JSON.stringify(screen.toJSON())).toContain('Offline. Changes stay pending until you reconnect.')
    await act(async () => { row.props.onCancel('claim') })
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('claim', 'member')
    expect(mocks.view.refresh).toHaveBeenCalledExactlyOnceWith(true)
})
