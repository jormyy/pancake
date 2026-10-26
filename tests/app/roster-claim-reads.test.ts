import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RosterScreen from '@/app/(tabs)/roster'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'

const mocks = vi.hoisted(() => ({ roster: vi.fn(), claims: vi.fn(), post: vi.fn() }))
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
    current: { id: 'member', team_name: 'Team' }, currentLeague: { id: 'league', status: 'active', waiver_mode: 'rolling' }, loading: false,
}) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/hooks/use-draft-room-launcher', () => ({ useDraftRoomLauncher: () => ({ openDraftRoom: vi.fn() }) }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.roster, isIREligible: () => false }))
vi.mock('@/lib/trades', () => ({ getPicksForMember: async () => [] }))
vi.mock('@/lib/waivers', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/waivers')>(), getMyWaiverClaims: mocks.claims, getMyWaiverPriority: async () => null,
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.post }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/roster-stats', () => ({ EMPTY_AVG_MAP: new Map(), EMPTY_STATS_MAP: new Map(), getRosterStatsMaps: async () => ({ avgMap: new Map(), avgStatsMap: new Map() }) }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn(), subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))
vi.mock('@/lib/lineup', () => ({ getRosterSlotPlan: async () => ({ slots: [], assignments: {} }) }))
vi.mock('@/lib/shared/season', () => ({ getActiveSeasonId: async () => 'season' }))
vi.mock('@/lib/league', () => ({ isTradingClosed: () => false }))
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
const claim = { id: 'claim', dropPlayerId: null }
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

it.each(['cancel', 'edit', 'reorder'])('makes one roster read after claim %s', async operation => {
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    expect(mocks.roster).toHaveBeenCalledTimes(1)
    const row = screen.root.findByType('RosterClaimItem' as React.ElementType)
    await act(async () => {
        if (operation === 'cancel') await row.props.onCancel('claim')
        if (operation === 'edit') await row.props.onEditBid(claim, 5)
        if (operation === 'reorder') await row.props.onReorder('claim', 'up')
        await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.roster).toHaveBeenCalledTimes(2)
    expect(mocks.claims).toHaveBeenCalledTimes(2)
})

it('keeps Cancel disabled after success until refreshed claims remove the row', async () => {
    await act(async () => { screen = create(React.createElement(RosterScreen)) })
    const row = () => screen.root.findByType('RosterClaimItem' as React.ElementType)
    await act(async () => { await row().props.onCancel('claim') })
    expect(row().props.cancellingId).toBe('claim')
    await act(async () => { await row().props.onCancel('claim') })
    expect(mocks.post).toHaveBeenCalledTimes(1)
    mocks.claims.mockResolvedValue([])
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.root.findAllByType('RosterClaimItem' as React.ElementType)).toHaveLength(0)
})
