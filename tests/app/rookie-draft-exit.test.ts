import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RookieDraftRoomScreen from '@/app/(modals)/rookie-draft-room'

const mocks = vi.hoisted(() => ({
    replace: vi.fn(), drop: vi.fn(), trim: vi.fn(),
    refresh: vi.fn(), hasState: true, loading: false, loadError: null as string | null,
    prospectsLoadError: null as string | null,
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
vi.mock('expo-router', () => ({ Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => ({ draftId: 'draft' }), useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    current: { id: 'member' }, currentLeague: { id: 'league', roster_size: 1 }, isCommissioner: false,
}) }))
vi.mock('@/hooks/useRookieDraftRoomController', () => ({ useRookieDraftRoomController: () => ({
    state: mocks.hasState ? { draft: { id: 'draft', leagueId: 'league', status: mocks.overflow ? 'in_progress' : 'completed', isMock: false }, picks: [], orders: [], nextPick: null } : null,
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
vi.mock('@/components/TaxiAcquisitionChoice', () => ({ TaxiAcquisitionChoice: 'TaxiAcquisitionChoice' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/ui/ErrorBanner', () => ({ ErrorBanner: 'ErrorBanner' }))
vi.mock('@/components/ui/LoadingState', () => ({ LoadingState: 'LoadingState' }))
vi.mock('@/lib/alert', () => ({ showSuccess: vi.fn() }))
vi.mock('@/lib/format', () => ({ countLabel: (count: number, word: string) => `${count} ${word}`, playerHeadshotUrl: () => '' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
beforeEach(() => {
    vi.clearAllMocks(); mocks.overflow = null; mocks.trimOverflow = null
    mocks.hasState = true; mocks.loading = false; mocks.loadError = null; mocks.prospectsLoadError = null
})
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each(['overflow', 'trim'] as const)('leaves the %s dialog without changing the required roster correction', async (kind) => {
    if (kind === 'overflow') mocks.overflow = { newPlayerName: 'Drafted Rookie' }
    else mocks.trimOverflow = { excess: 1, dropList: [] }
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const dialog = screen.root.findAllByType('Modal' as React.ElementType).find((node) => node.props.visible)
    expect(dialog).toBeDefined()
    const exit = dialog!.findAllByType('MotionPressable' as React.ElementType).filter((node) => node.props.accessibilityLabel === 'Back to League')
    expect(exit).toHaveLength(1)
    await act(async () => exit[0].props.onPress())
    expect(mocks.replace).toHaveBeenCalledWith('/league?tab=draftBoard')
    await act(async () => dialog!.props.onRequestClose())
    expect(mocks.replace).toHaveBeenCalledTimes(2)
    expect(mocks.drop).not.toHaveBeenCalled()
    expect(mocks.trim).not.toHaveBeenCalled()
    await act(async () => { screen.update(React.createElement(RookieDraftRoomScreen)) })
    expect(screen.root.findAllByType('Modal' as React.ElementType).filter((node) => node.props.visible)).toHaveLength(1)
})

it('waits for the initial draft read before showing a missing room', async () => {
    mocks.hasState = false; mocks.loading = true
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found.')).toHaveLength(0)
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(1)
    mocks.loading = false
    await act(async () => screen.update(React.createElement(RookieDraftRoomScreen)))
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found.')).toHaveLength(1)
})

it('offers retry for an initial draft read failure without claiming the room is missing', async () => {
    mocks.hasState = false; mocks.loadError = 'Draft read unavailable'
    await act(async () => { screen = create(React.createElement(RookieDraftRoomScreen)) })
    const banners = screen.root.findAllByType('ErrorBanner' as React.ElementType)
    expect(banners).toHaveLength(1)
    expect(banners[0].props.message).toContain('Could not load this draft')
    expect(screen.root.findAll((node) => node.props.children === 'Draft not found.')).toHaveLength(0)
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
