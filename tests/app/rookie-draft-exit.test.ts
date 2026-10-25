import React from 'react'
import { StackActions, StackRouter } from '@react-navigation/routers'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RookieDraftRoomScreen from '@/app/(modals)/rookie-draft-room'
import DraftRoomScreen from '@/app/(modals)/draft-room'

const mocks = vi.hoisted(() => ({
    replace: vi.fn(), dismissTo: vi.fn(), drop: vi.fn(), trim: vi.fn(),
    refresh: vi.fn(), hasState: true, loading: false, loadError: null as string | null,
    prospectsLoadError: null as string | null,
    nextMember: null as string | null,
    overflow: null as { newPlayerName: string } | null,
    trimOverflow: null as { excess: number; dropList: never[] } | null,
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput',
    Modal: 'Modal', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
    useWindowDimensions: () => ({ width: 393, height: 852 }), StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('expo-router', () => ({ Redirect: 'Redirect', Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => ({ draftId: 'draft' }), useRouter: () => ({ replace: mocks.replace, dismissTo: mocks.dismissTo }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    current: { id: 'member' }, currentLeague: { id: 'league', roster_size: 1 }, isCommissioner: false,
}) }))
vi.mock('@/hooks/useRookieDraftRoomController', () => ({ useRookieDraftRoomController: () => ({
    state: mocks.hasState ? { draft: { id: 'draft', leagueId: 'league', status: mocks.overflow || mocks.nextMember ? 'in_progress' : 'completed', isMock: false }, picks: [], orders: [],
        nextPick: mocks.nextMember ? { memberId: mocks.nextMember, teamName: 'Team on the clock', round: 1 } : null } : null,
    actionsReady: true,
    loading: mocks.loading, loadError: mocks.loadError, prospectsLoadError: mocks.prospectsLoadError,
    query: '', setQuery: vi.fn(), prospects: [], prospectsLoading: false, picking: false,
    draftToTaxi: false, setDraftToTaxi: vi.fn(), activeTab: 'prospects', setActiveTab: vi.fn(), secondsLeft: 0,
    pickError: null, completionError: null, rosterOverflow: mocks.overflow, rosterForDrop: [],
    resolvingOverflow: false, trimOverflow: mocks.trimOverflow, trimmingId: null, memberId: 'member',
    refresh: mocks.refresh, handleTrimDrop: mocks.trim, resolveByDrop: mocks.drop, handlePick: vi.fn(), handleCommissionerPick: vi.fn(),
}) }))
vi.mock('@/components/league/draft-room/useDraftAdminControls', () => ({ useDraftAdminControls: () => ({}) }))
vi.mock('@/components/league/draft-room/DraftAdminBar', () => ({ DraftAdminBar: 'DraftAdminBar' }))
vi.mock('@/components/league/draft-room/DraftScreenHeader', () => ({ DraftScreenHeader: 'DraftScreenHeader' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/settings/SettingsGroup', () => ({ SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/ui/ErrorBanner', () => ({ ErrorBanner: 'ErrorBanner' }))
vi.mock('@/components/ui/LoadingState', () => ({ LoadingState: 'LoadingState' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/league/draft-room/AuctionDraftSidePanel', () => ({ AuctionDraftSidePanel: 'AuctionDraftSidePanel' }))
vi.mock('@/components/league/draft-room/AuctionIdlePanel', () => ({ AuctionIdlePanel: 'AuctionIdlePanel' }))
vi.mock('@/components/league/draft-room/AuctionLivePanel', () => ({ AuctionLivePanel: 'AuctionLivePanel' }))
vi.mock('@/hooks/useAuctionDraftRoomController', () => ({ useAuctionDraftRoomController: () => ({
    state: null, loading: mocks.loading, loadError: mocks.loadError, refresh: mocks.refresh,
}) }))
vi.mock('@/lib/alert', () => ({ showSuccess: vi.fn() }))
vi.mock('@/lib/format', () => ({ countLabel: (count: number, word: string) => `${count} ${word}`, playerHeadshotUrl: () => '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks(); mocks.overflow = null; mocks.trimOverflow = null; mocks.nextMember = null
    mocks.hasState = true; mocks.loading = false; mocks.loadError = null; mocks.prospectsLoadError = null
})
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each(['member', 'other'])('only offers a pick when the manager owns the turn: %s', async (nextMember) => {
    mocks.nextMember = nextMember
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const prospect = screen.root.findByType('FlashList' as React.ElementType).props.renderItem({
        item: { id: 'prospect', display_name: 'A rookie', nba_team: 'LAL', position: 'SG', nba_draft_number: 1 },
    })
    let row!: ReactTestRenderer
    await act(async () => { row = create(prospect) })
    try {
        const action = row.root.findByType('MotionPressable' as React.ElementType)
        expect(action.props.disabled).toBe(nextMember !== 'member')
        expect(action.props.accessibilityRole).toBe(nextMember === 'member' ? 'button' : 'text')
        expect(action.props.accessibilityLabel).toBe(nextMember === 'member' ? 'Pick A rookie' : 'A rookie')
        expect(row.root.findAll((node) => node.props.children === 'Pick')).toHaveLength(nextMember === 'member' ? 1 : 0)
    } finally { await act(async () => row.unmount()) }
})

it.each(['overflow', 'trim'] as const)('leaves the %s dialog without changing the required roster correction', async (kind) => {
    if (kind === 'overflow') mocks.overflow = { newPlayerName: 'Drafted Rookie' }
    else mocks.trimOverflow = { excess: 1, dropList: [] }
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const dialog = screen.root.findAllByType('Modal' as React.ElementType).find((node) => node.props.visible)
    expect(dialog).toBeDefined()
    const exit = dialog!.findAllByType('MotionPressable' as React.ElementType).filter((node) => node.props.accessibilityLabel === 'Back to League')
    expect(exit).toHaveLength(1)
    await act(async () => exit[0].props.onPress())
    expect(mocks.dismissTo).toHaveBeenCalledWith('/league?tab=draft')
    await act(async () => dialog!.props.onRequestClose())
    expect(mocks.dismissTo).toHaveBeenCalledTimes(2)
    expect(mocks.drop).not.toHaveBeenCalled()
    expect(mocks.trim).not.toHaveBeenCalled()
    await act(async () => { screen.update(React.createElement(RookieDraftRoomScreen)) })
    expect(screen.root.findAllByType('Modal' as React.ElementType).filter((node) => node.props.visible)).toHaveLength(1)
})

it.each([['rookie', RookieDraftRoomScreen], ['auction', DraftRoomScreen]] as const)('waits for the initial read, then offers a way back from a missing room: %s', async (_name, Room) => {
    mocks.hasState = false; mocks.loading = true
    await act(async () => { screen = create(React.createElement(Room)) })
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found')).toHaveLength(0)
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(1)
    mocks.loading = false
    await act(async () => screen.update(React.createElement(Room)))
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found')).toHaveLength(1)
    expect(screen.root.findAll((node) => node.props.children === 'This draft is no longer available.')).toHaveLength(1)
    const buttons = screen.root.findAllByType('Button' as React.ElementType)
    expect(buttons.map(button => button.props.title)).toEqual(['Back to League'])
    await act(async () => buttons[0].props.onPress())
    expect(mocks.dismissTo).toHaveBeenCalledWith('/league?tab=draft')
})

it('offers retry for an initial draft read failure without claiming the room is missing', async () => {
    mocks.hasState = false; mocks.loadError = 'Draft read unavailable'
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const banners = screen.root.findAllByType('ErrorBanner' as React.ElementType)
    expect(banners).toHaveLength(1)
    expect(banners[0].props.message).toContain('Could not load this draft')
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found')).toHaveLength(0)
    await act(async () => banners[0].props.onRetry())
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    mocks.hasState = true; mocks.loadError = null
    await act(async () => screen.update(React.createElement(RookieDraftRoomScreen)))
    expect(screen.root.findAllByType('ErrorBanner' as React.ElementType)).toHaveLength(0)
})

it('does not call a failed prospect read an empty draft pool', async () => {
    mocks.prospectsLoadError = 'Prospects read unavailable'
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const banners = screen.root.findAllByType('ErrorBanner' as React.ElementType)
    expect(banners).toHaveLength(1)
    expect(banners[0].props.message).toContain('Could not load prospects')
    expect(screen.root.findByType('FlashList' as React.ElementType).props.ListEmptyComponent).toBeNull()
    await act(async () => banners[0].props.onRetry())
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    mocks.prospectsLoadError = null
    await act(async () => screen.update(React.createElement(RookieDraftRoomScreen)))
    expect(screen.root.findAllByType('ErrorBanner' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findByType('FlashList' as React.ElementType).props.ListEmptyComponent).not.toBeNull()
})

it.each([['rookie', RookieDraftRoomScreen], ['auction', DraftRoomScreen]] as const)('returns from a draft to the original tabs tree: %s', async (_name, Room) => {
    const router = StackRouter({ initialRouteName: '(tabs)' })
    const options = { routeNames: ['(tabs)', '(modals)'], routeParamList: {}, routeGetIdList: {} }
    let root = router.getInitialState(options)
    const originalTabs = root.routes[0].key
    const dispatch = (action: Parameters<typeof router.getStateForAction>[1]) => {
        root = router.getStateForAction(root, action, options) ?? root
    }
    mocks.replace.mockImplementation(() => dispatch(StackActions.replace('(tabs)', { screen: 'league', params: { tab: 'draft' } })))
    mocks.dismissTo.mockImplementation(() => dispatch(StackActions.popTo('(tabs)', { screen: 'league', params: { tab: 'draft' } })))
    await act(async () => { screen = create(React.createElement(Room)) })
    for (let visit = 0; visit < 2; visit++) {
        dispatch(StackActions.push('(modals)', { screen: 'draft-room' }))
        await act(async () => screen.root.findByType('DraftScreenHeader' as React.ElementType).props.onBack())
        expect(root.routes.map(route => route.name)).toEqual(['(tabs)'])
        expect(root.routes[0].key).toBe(originalTabs)
        expect(root.routes[0].params).toEqual({ screen: 'league', params: { tab: 'draft' } })
        expect(root.index).toBe(0)
    }
    expect(mocks.replace).not.toHaveBeenCalled()
})
