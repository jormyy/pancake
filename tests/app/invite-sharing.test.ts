import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CreateLeagueScreen from '@/app/(modals)/create-league'
import { useLeagueScreenState } from '@/hooks/use-league-screen-state'

const mocks = vi.hoisted(() => ({ copy: vi.fn(), share: vi.fn(), alert: vi.fn(), success: vi.fn(), refresh: vi.fn(), back: vi.fn() }))
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, Share: { share: mocks.share }, StyleSheet: { create: (value: unknown) => value },
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView',
    useWindowDimensions: () => ({ width: 1440, height: 900 }),
}))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ push: vi.fn(), setParams: vi.fn() }), useLocalSearchParams: () => ({}) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league', invite_code: 'TEST-INVITE' }, refresh: mocks.refresh }) }))
vi.mock('@/lib/league', () => ({ createLeague: async () => ({ invite_code: 'TEST-INVITE' }) }))
vi.mock('@/components/ui', () => ({ Input: 'Input', Button: 'Button', usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: ({ actions, children }: React.PropsWithChildren<{ actions: React.ReactNode }>) => React.createElement('View', null, actions, children) }))
vi.mock('@/components/ui/useGoBack', () => ({ useGoBack: () => mocks.back }))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success }))
vi.mock('@/hooks/use-league-tab-resources', () => ({ useLeagueTabResources: () => ({ mockRooms: [], invalidateTab: vi.fn() }) }))
vi.mock('@/hooks/use-league-draft-controller', () => ({ useLeagueDraftController: () => ({ fetchActiveDraft: vi.fn() }) }))
vi.mock('@/hooks/use-mock-rooms-controller', () => ({ useMockRoomsController: () => ({}) }))
vi.mock('@/lib/league/realtime', () => ({ leagueScreenWatches: () => [] }))
vi.mock('@/lib/realtime', () => ({
    debounceRealtimeRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), subscribeToTableChanges: vi.fn(),
    disposeTableChangeSubscription: vi.fn(), reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let share: () => Promise<void>
const mount = async (flow: string) => {
    if (flow === 'settings') {
        const Probe = () => { share = useLeagueScreenState().shareInviteCode; return null }
        await act(async () => { screen = create(React.createElement(Probe)) })
        return
    }
    await act(async () => { screen = create(React.createElement(CreateLeagueScreen)) })
    for (const label of ['League name', 'Your team name']) {
        await act(async () => { screen.root.findAllByType('Input' as React.ElementType).find((input) => input.props.accessibilityLabel === label)!.props.onChangeText('Test name') })
    }
    await act(async () => { await screen.root.findAllByType('Button' as React.ElementType).find((button) => button.props.accessibilityLabel === 'Create league')!.props.onPress() })
    share = screen.root.findAllByType('Button' as React.ElementType).find((button) => button.props.accessibilityLabel === 'Share invite code')!.props.onPress
}
beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('navigator', { clipboard: { writeText: mocks.copy } })
    mocks.share.mockRejectedValue(new Error('Share is not supported in this browser'))
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })
it.each(['create', 'settings'])('%s shares by clipboard when Web Share is unavailable', async (flow) => {
    await mount(flow)
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.copy).toHaveBeenCalledOnce()
    expect(mocks.copy.mock.calls[0][0]).toContain('TEST-INVITE')
    expect(mocks.success).toHaveBeenCalledOnce()
    expect(mocks.share).not.toHaveBeenCalled()
})
it.each(['create', 'settings'])('%s reports a clipboard failure and allows retry', async (flow) => {
    mocks.copy.mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce(undefined)
    await mount(flow)
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.alert).toHaveBeenCalledOnce()
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.copy).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledOnce()
})
it.each(['create', 'settings'])('%s provides manual copy guidance when neither browser API exists', async (flow) => {
    vi.stubGlobal('navigator', {})
    await mount(flow)
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.alert).toHaveBeenCalledWith('Sharing unavailable', 'Copy the invite code shown on this page.')
    expect(mocks.copy).not.toHaveBeenCalled()
    expect(mocks.share).not.toHaveBeenCalled()
})
it.each(['create', 'settings'])('%s treats a cancelled share as cancellation and allows retry', async (flow) => {
    vi.stubGlobal('navigator', { share: vi.fn(), clipboard: { writeText: mocks.copy } })
    mocks.share.mockRejectedValueOnce(Object.assign(new Error('Cancelled'), { name: 'AbortError' })).mockResolvedValueOnce(undefined)
    await mount(flow)
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.alert).not.toHaveBeenCalled()
    await act(async () => { await expect(share()).resolves.toBeUndefined() })
    expect(mocks.share).toHaveBeenCalledTimes(2)
    expect(mocks.copy).not.toHaveBeenCalled()
})
