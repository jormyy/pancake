import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DraftRoomScreen from '@/app/(modals)/draft-room'

const state = vi.hoisted(() => ({ loading: true, error: null as string | null, refresh: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('expo-router', () => ({ Redirect: 'Redirect', Stack: { Screen: () => null }, useLocalSearchParams: () => ({ draftId: 'draft' }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' } }) }))
vi.mock('@/hooks/useAuctionDraftRoomController', () => ({ useAuctionDraftRoomController: () => ({ state: null, loading: state.loading, loadError: state.error, refresh: state.refresh }) }))
vi.mock('@/components/league/draft-room/useDraftAdminControls', () => ({ useDraftAdminControls: () => ({}) }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/ui/ScreenFrame', () => ({ ScreenFrame: 'ScreenFrame' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/components/league/draft-room/DraftScreenHeader', () => ({ DraftScreenHeader: 'DraftScreenHeader' }))
vi.mock('@/components/league/draft-room/DraftAdminBar', () => ({ DraftAdminBar: 'DraftAdminBar' }))
vi.mock('@/components/league/draft-room/AuctionDraftSidePanel', () => ({ AuctionDraftSidePanel: 'AuctionDraftSidePanel' }))
vi.mock('@/components/league/draft-room/AuctionIdlePanel', () => ({ AuctionIdlePanel: 'AuctionIdlePanel' }))
vi.mock('@/components/league/draft-room/AuctionLivePanel', () => ({ AuctionLivePanel: 'AuctionLivePanel' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
beforeEach(() => { state.loading = true; state.error = null; state.refresh.mockClear() })
afterEach(async () => { await act(async () => screen?.unmount()) })
it('keeps the auction frame without claiming a pending draft is missing', async () => {
    await act(async () => { screen = create(React.createElement(DraftRoomScreen)) })
    expect(screen.root.findAllByType('DraftScreenHeader' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findAllByType('Text' as React.ElementType)).toHaveLength(0)
    state.loading = false
    await act(async () => screen.update(React.createElement(DraftRoomScreen)))
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'Draft not found')).toBe(true)
})
it('keeps a load error and its retry visible', async () => {
    state.loading = false; state.error = 'The draft request failed.'
    await act(async () => { screen = create(React.createElement(DraftRoomScreen)) })
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === state.error)).toBe(true)
    await act(async () => screen.root.findByType('MotionPressable' as React.ElementType).props.onPress())
    expect(state.refresh).toHaveBeenCalledOnce()
})

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))
