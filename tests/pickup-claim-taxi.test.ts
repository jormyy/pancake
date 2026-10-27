import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import { rosterPlayer } from './helpers/fixtures'

vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, subscribeScreenView: () => () => {},
    readScreenView: async () => ({ context: { seasonId: 'season' }, player: { id: 'target', display_name: 'IR target', injury_status: mocks.injury, years_exp: mocks.years, career_regular_season_games: mocks.games },
        roster: await mocks.read(), priority: 1, clearsAt: null, transactionState: null, members: [{ id: 'member', user_id: 'user' }], claims: [], taxiExitIds: [...mocks.exits] }),
}))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))

const mocks = vi.hoisted(() => ({ claim: vi.fn(), read: vi.fn(), injury: null as string | null, size: 1, years: 2, games: 64 as number | null, exits: new Set<string>(), epoch: 0, alert: vi.fn() }))
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput', Switch: 'Switch', ScrollView: 'ScrollView', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => ({ playerId: 'target' }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', roster_size: mocks.size, ir_slots: 1, taxi_slots: 1, status: 'active' } }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => vi.fn() }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 370 }), PageHeader: ({ actions }: { actions: React.ReactNode }) => React.createElement('Header', null, actions) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/lib/league', () => ({ getLeagueMembers: async () => [{ id: 'member', user_id: 'user' }] }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.read, getTaxiExitPlayerIds: async () => mocks.exits }))
vi.mock('@/lib/players', () => ({ getPlayer: async () => ({ id: 'target', display_name: 'IR target', injury_status: mocks.injury, years_exp: mocks.years, career_regular_season_games: mocks.games }) }))
vi.mock('@/lib/waivers', () => ({ claimProcessDateLabel: () => 'Tomorrow', claimProcessTimeLabel: () => 'tomorrow', getMyWaiverPriority: async () => 1, scheduledClaimLabel: () => 'Tomorrow', getWaiverClearsAt: async () => null, submitWaiverClaim: mocks.claim }))
vi.mock('@/lib/roster-add-flow', () => ({ loadAddLimitState: async () => null }))
vi.mock('@/lib/format', () => ({ isIneligibleIR: () => false, playerHeadshotUrl: () => null }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: vi.fn(), confirmAction: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = { canRead: () => true, canAct: () => true, capture: () => 0, isCurrent: () => true, markReady: vi.fn(), blockActions: vi.fn() }; return { useDraftActivity: () => ({ ...gate, epoch: mocks.epoch }) } })
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: (props: Record<string, unknown>) => React.createElement('IRResolutionModal', props) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const type = (value: string) => value as React.ElementType
const toggle = () => screen.root.findByProps({ accessibilityLabel: 'Place on taxi' })
const submit = () => screen.root.findAllByType(type('Pressable')).find(node => node.props.accessibilityLabel === 'Submit waiver claim')!
beforeEach(async () => {
    vi.clearAllMocks(); mocks.injury = null; mocks.epoch = 0; mocks.size = 1; mocks.games = 64; mocks.years = 2; mocks.exits = new Set()
    mocks.claim.mockResolvedValue(undefined)
    mocks.read.mockResolvedValue([rosterPlayer()])
    await act(async () => { screen = create(React.createElement(ClaimPlayerScreen)) })
})
afterEach(async () => { await act(async () => screen.unmount()) })

it('defaults a full-roster eligible claim to taxi and sends its destination', async () => {
    expect(toggle().props.value).toBe(true)
    await act(async () => submit().props.onPress())
    expect(mocks.claim).toHaveBeenCalledWith('member', 'league', 'target', undefined, { bidAmount: 0, toTaxi: true })
})
it('defaults taxi off with active room and preserves the owner choice on refresh', async () => {
    mocks.size = 2; mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    expect(toggle().props.value).toBe(false)
    await act(async () => toggle().props.onValueChange(true))
    mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    expect(toggle().props.value).toBe(true)
    await act(async () => submit().props.onPress())
    expect(mocks.claim.mock.calls[0][4]).toEqual({ bidAmount: 0, toTaxi: true })
})
it('keeps IR and taxi mutually exclusive, with IR first by default', async () => {
    mocks.injury = 'Out'; mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    const ir = () => screen.root.findByProps({ accessibilityLabel: 'Place on IR' })
    expect(ir().props.value).toBe(true)
    expect(toggle().props.value).toBe(false)
    await act(async () => toggle().props.onValueChange(true))
    expect(ir().props.value).toBe(false)
    await act(async () => submit().props.onPress())
    expect(mocks.claim.mock.calls[0][4]).toEqual({ bidAmount: 0, toIr: false, toTaxi: true })
})
it.each(['unknown', '65 games', 'exit'])('omits taxi for %s', async reason => {
    if (reason === 'unknown') mocks.games = null
    if (reason === '65 games') mocks.games = 65
    if (reason === 'exit') mocks.exits.add('target')
    mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Place on taxi' })).toHaveLength(0)
})


it('opens roster resolution before claiming with a locally ineligible taxi player', async () => {
    const taxi = rosterPlayer({ is_on_taxi: true })
    taxi.players = { ...taxi.players, years_exp: 2, career_regular_season_games: 65 }
    mocks.read.mockResolvedValue([taxi]); mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    await act(async () => submit().props.onPress())
    await act(async () => { await vi.dynamicImportSettled() })
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(screen.root.findByType('IRResolutionModal' as React.ElementType).props.ineligibleIR).toEqual([taxi])
})
it('opens roster resolution when a stale claim receives PA009', async () => {
    mocks.size = 2; mocks.epoch += 1
    await act(async () => screen.update(React.createElement(ClaimPlayerScreen)))
    mocks.claim.mockRejectedValue({ code: 'PA009', message: 'Server taxi problem' })
    await act(async () => submit().props.onPress())
    await act(async () => { await vi.dynamicImportSettled() })
    expect(screen.root.findByType('IRResolutionModal' as React.ElementType).props.serverMessage).toBe('Server taxi problem')
})
