import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import { rosterPlayer } from '@/tests/helpers/fixtures'

vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, subscribeScreenView: () => () => {},
    readScreenView: async () => ({ context: { seasonId: 'season' }, player: { id: 'target', display_name: 'IR target', injury_status: mocks.injury },
        roster: await mocks.read(), priority: 1, clearsAt: null, transactionState: null, members: [{ id: 'member', user_id: 'user' }], claims: [], taxiExitIds: [] }),
}))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))

const mocks = vi.hoisted(() => ({ claim: vi.fn(), read: vi.fn(), members: vi.fn(), injury: 'Out' as string | null, epoch: 0, alert: vi.fn(), league: {} as Record<string, unknown> }))
vi.mock('react-native', () => ({ Image: 'Image', View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', Switch: 'Switch', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ playerId: 'target' }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: mocks.league }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 370 }), PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('Header', null, actions) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: mocks.members }))
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
const fullLimits = { id: 'league', roster_size: 1, ir_slots: 1, taxi_slots: 0, status: 'active' }
const setLeague = (league: Record<string, unknown>) => { mocks.league = league }
const rerender = () => act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
const texts = () => screen.root.findAllByType(type('Text')).flatMap(node => node.props.children).join(' ')
const member = [{ id: 'member', user_id: 'user' }]
beforeEach(async () => {
    vi.clearAllMocks(); mocks.injury = 'Out'; mocks.epoch = 0
    setLeague(fullLimits)
    mocks.read.mockResolvedValue([rosterPlayer({ id: 'synthetic-active' })])
    mocks.members.mockResolvedValue(member)
})
afterEach(async () => { await act(async () => screen.unmount()) })
const mount = () => act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })

it('synthetic league: explains and disables Submit while roster limits are missing, then submits once they load', async () => {
    setLeague({ id: 'league', roster_size: 1, taxi_slots: 0, status: 'active' })
    await mount()
    expect(submit().props.disabled).toBe(true)
    expect(submit().props.accessibilityHint).toBe('League roster settings are still loading. Try again in a moment.')
    expect(screen.root.findByProps({ testID: 'claim-limits-loading' }).props.role).toBe('status')
    await act(async () => submit().props.onPress())
    expect(mocks.claim).not.toHaveBeenCalled()
    setLeague(fullLimits)
    await rerender()
    expect(submit().props.disabled).toBe(false)
    expect(screen.root.findAllByProps({ testID: 'claim-limits-loading' })).toHaveLength(0)
    await act(async () => submit().props.onPress())
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith('member', 'league', 'target', undefined, { bidAmount: 0, toIr: true })
})

it.each([
    ['IR slots drop to zero', { ...fullLimits, ir_slots: 0 }, 'Roster settings changed'],
    ['limits go missing', { id: 'league', roster_size: 1, taxi_slots: 0, status: 'active' }, 'Roster settings loading'],
] as const)('synthetic league: no IR claim is written when %s during the membership read', async (_label, changed, title) => {
    await mount()
    expect(toggle().props.value).toBe(true)
    let release!: (value: typeof member) => void
    mocks.members.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = submit().props.onPress() })
    setLeague(changed)
    await rerender()
    expect(screen.root.findAllByType(type('Switch'))).toHaveLength(0)
    await act(async () => { release(member); await pending })
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.alert).toHaveBeenCalledWith(title, expect.any(String))
})

it('synthetic league: unchanged limits during the membership read still submit the IR claim', async () => {
    await mount()
    let release!: (value: typeof member) => void
    mocks.members.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = submit().props.onPress() })
    setLeague({ ...fullLimits })
    await rerender()
    await act(async () => { release(member); await pending })
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith('member', 'league', 'target', undefined, { bidAmount: 0, toIr: true })
    expect(mocks.alert).not.toHaveBeenCalled()
    expect(texts()).not.toContain('still loading')
})
