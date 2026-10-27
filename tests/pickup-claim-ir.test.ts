import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import { rosterPlayer } from './helpers/fixtures'

vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, subscribeScreenView: () => () => {},
    readScreenView: async () => ({ context: { seasonId: 'season' }, player: { id: 'target', display_name: 'IR target', injury_status: mocks.injury },
        roster: await mocks.read(), priority: 1, clearsAt: null, transactionState: null, members: [{ id: 'member', user_id: 'user' }], claims: [], taxiExitIds: [] }),
}))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))

const mocks = vi.hoisted(() => ({ claim: vi.fn(), read: vi.fn(), injury: 'Out' as string | null, epoch: 0, alert: vi.fn() }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', Switch: 'Switch', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ playerId: 'target' }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', roster_size: 1, ir_slots: 1, status: 'active' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 370 }), PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('Header', null, actions) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: async () => [{ id: 'member', user_id: 'user' }] }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.read }))
vi.mock('@/lib/players', () => ({ getPlayer: async () => ({ id: 'target', display_name: 'IR target', injury_status: mocks.injury }) }))
vi.mock('@/lib/waivers', () => ({ claimProcessDateLabel: () => 'Tomorrow', claimProcessTimeLabel: () => 'tomorrow', getMyWaiverPriority: async () => 1, scheduledClaimLabel: () => 'Tomorrow', getWaiverClearsAt: async () => null, submitWaiverClaim: mocks.claim }))
vi.mock('@/lib/roster-add-flow', () => ({ loadAddLimitState: async () => null }))
vi.mock('@/lib/format', () => ({ isIneligibleIR: () => false, playerHeadshotUrl: () => null }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = { canRead: () => true, canAct: () => true, capture: () => 0, isCurrent: () => true, markReady: vi.fn(), blockActions: vi.fn() }; return { useDraftActivity: () => ({ ...gate, epoch: mocks.epoch }) } })
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: 'IRResolutionModal' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const type = (value: string) => value as React.ElementType
const toggle = () => screen.root.findByType(type('Switch'))
const submit = () => screen.root.findAllByType(type('Pressable')).find(node => node.props.accessibilityLabel === 'Submit waiver claim')!
beforeEach(async () => {
    vi.clearAllMocks(); mocks.injury = 'Out'; mocks.epoch = 0
    mocks.read.mockResolvedValue([rosterPlayer()])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
})
afterEach(async () => { await act(async () => screen.unmount()) })
it('defaults eligible claims to IR with no drop despite a full active roster', async () => {
    expect(toggle().props.value).toBe(true)
    await act(async () => submit().props.onPress())
    expect(mocks.claim).toHaveBeenCalledWith('member', 'league', 'target', undefined, { bidAmount: 0, toIr: true })
})
it('requires a drop when the owner turns off IR and preserves that choice on refresh', async () => {
    await act(async () => toggle().props.onValueChange(false))
    mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    expect(toggle().props.value).toBe(false)
    await act(async () => submit().props.onPress())
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith('Select Drop', expect.any(String))
    const drop = screen.root.findAllByType(type('Pressable')).find(node => node.props.accessibilityLabel === 'Select Player A to drop')!
    await act(async () => drop.props.onPress())
    await act(async () => submit().props.onPress())
    expect(mocks.claim).toHaveBeenCalledWith('member', 'league', 'target', 'player-a', { bidAmount: 0, toIr: false })
})
it.each(['healthy', 'full IR'])('omits IR placement for %s', async reason => {
    if (reason === 'healthy') mocks.injury = null
    else mocks.read.mockResolvedValue([rosterPlayer({ is_on_ir: true }), rosterPlayer()])
    mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    expect(screen.root.findAllByType(type('Switch'))).toHaveLength(0)
})
