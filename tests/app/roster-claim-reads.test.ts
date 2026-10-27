import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import { WaiversSection } from '@/components/waivers/WaiversSection'
import { memberTransactionState } from '@/tests/helpers/fixtures'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const mocks = vi.hoisted(() => ({ roster: vi.fn(), claims: vi.fn(), post: vi.fn() }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: function useScreenView() {
    const [data, setData] = React.useState<Record<string, unknown>>()
    const refresh = React.useCallback(async () => {
        setData({ roster: [], picks: [], claims: await mocks.claims(), avgMap: {}, avgStatsMap: {}, waiverPriority: 6, faabBalance: 100,
            slotPlan: { slots: [], assignments: {} }, transactionState: memberTransactionState({ faabBalance: 100, weeklyAddLimit: 2, weeklyAddCount: 0 }), taxiExitPlayerIds: [] })
    }, [])
    React.useEffect(() => { void refresh() }, [refresh])
    return { data, loading: !data, error: null, refresh }
} }))
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
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: async () => null }))
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Medium: 'Medium' } }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    current: { id: 'member', team_name: 'Team' }, currentLeague: { id: 'league', status: 'active', waiver_mode: 'faab' }, loading: false,
}) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.roster, isIREligible: () => false }))
vi.mock('@/lib/trades', () => ({ getPicksForMember: async () => [] }))
vi.mock('@/lib/waivers', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/waivers')>(), getMyWaiverClaims: mocks.claims, getMyWaiverPriority: async () => 6,
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
vi.mock('@/components/ui', () => ({ Page: 'Page', PageHeader: 'PageHeader', Button: 'Button', usePageMetrics: () => ({ padX: 16, usableWidth: 358 }) }))
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
const claim = { id: 'claim', playerId: 'player', playerName: 'Player', dropPlayerId: null, status: 'pending', processDate: '2099-10-28' }
beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    setSessionOwner('user')
    clearSessionCaches()
    mocks.roster.mockResolvedValue([])
    mocks.claims.mockResolvedValue([claim])
    mocks.post.mockResolvedValue({ claimOrder: 1 })
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it.each(['cancel', 'edit', 'reorder'])('refreshes Waivers after claim %s without loading the roster', async operation => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    expect(mocks.claims).toHaveBeenCalledTimes(1)
    const row = screen.root.findByType('RosterClaimItem' as React.ElementType)
    await act(async () => {
        if (operation === 'cancel') row.props.onCancel('claim')
        if (operation === 'edit') await row.props.onEditBid(claim, 5)
        if (operation === 'reorder') row.props.onReorder('claim', 'up')
    })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.claims).toHaveBeenCalledTimes(2)
    expect(mocks.roster).not.toHaveBeenCalled()
})

it('blocks repeated cancellation until Waivers refresh removes the claim', async () => {
    let complete!: () => void
    mocks.post.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve }))
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const row = () => screen.root.findByType('RosterClaimItem' as React.ElementType)
    await act(async () => { row().props.onCancel('claim') })
    expect(row().props.cancellingId).toBe('claim')
    await act(async () => { row().props.onCancel('claim') })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    mocks.claims.mockResolvedValue([])
    await act(async () => { complete() })
    expect(screen.root.findAllByType('RosterClaimItem' as React.ElementType)).toHaveLength(0)
})

it('keeps pending claims out of the Roster screen', async () => {
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    expect(mocks.claims).toHaveBeenCalledTimes(1)
    expect(screen.root.findAllByType('RosterClaimItem' as React.ElementType)).toHaveLength(0)
})

it('keeps the Waivers budget, priority, next run and pickup count without explanatory prose', async () => {
    await act(async () => { screen = create(React.createElement(WaiversSection, { active: true, onFindPlayer: vi.fn() })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join(' ')
    expect(text).toContain('Available FAAB $100 · Priority #6')
    expect(text).toContain('Next run ')
    expect(text).toContain('Pickups 0/2 this week')
    expect(text).not.toMatch(/Dropped players wait|Bids stay private|Higher bids go first|Claim order decides|Successful pickups|scoring week/)
})
