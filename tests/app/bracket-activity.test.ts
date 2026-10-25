import { clearPersistentCaches } from '@/lib/persistent-cache'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import BracketScreen from '@/app/(modals)/bracket'

const state = vi.hoisted(() => ({ active: true, epoch: 0, getBracket: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => {
    const gate = { canRead: () => state.active, capture: () => state.epoch,
        isCurrent: (epoch: number) => state.active && epoch === state.epoch }
    return { useDraftActivity: () => ({ ...gate, epoch: state.epoch }) }
})
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 1200, height: 900 }) }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ replace: state.replace, dismissTo: state.dismissTo }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/lib/bracket', () => ({ getPlayoffBracket: state.getBracket }))
vi.mock('@/lib/format', () => ({ formatPoints: String }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/components/ui', () => ({ ErrorBanner: 'ErrorBanner', LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 1200 }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => { clearPersistentCaches(); vi.clearAllMocks(); state.active = true; state.epoch = 0; state.getBracket.mockResolvedValue(null) })
it('defers bracket reads until the visible connected route returns', async () => {
    state.active = false
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    expect(state.getBracket).not.toHaveBeenCalled()
    state.active = true; state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    expect(state.getBracket).toHaveBeenCalledTimes(1)
    await act(async () => view.unmount())
})
it('discards a bracket reply after suspension and replays one refresh', async () => {
    let finish!: (value: null) => void
    state.getBracket.mockReturnValueOnce(new Promise<null>(resolve => { finish = resolve }))
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    state.active = false; state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    await act(async () => finish(null))
    expect(view.root.findAllByProps({ children: 'No playoff bracket yet' })).toHaveLength(0)
    state.active = true; state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    expect(state.getBracket).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByProps({ children: 'No playoff bracket yet' })).toHaveLength(1)
    await act(async () => view.unmount())
})
it('keeps settled empty content visible through revalidation and a failed refresh', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    let fail!: (error: Error) => void
    state.getBracket.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    expect(view.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(0)
    expect(view.root.findAllByProps({ children: 'No playoff bracket yet' })[0].props.children).toBe('No playoff bracket yet')
    expect(view.root.findAll(node => node.props['aria-busy'] === true)).toHaveLength(1)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => fail(new Error('offline')))
    expect(view.root.findAllByProps({ children: 'No playoff bracket yet' })[0].props.children).toBe('No playoff bracket yet')
    const banner = view.root.findByType('ErrorBanner' as React.ElementType)
    expect(banner.props.message).toBe('Could not refresh the bracket.')
    state.getBracket.mockResolvedValue(null)
    await act(async () => banner.props.onRetry())
    expect(view.root.findAllByType('ErrorBanner' as React.ElementType)).toHaveLength(0)
    await act(async () => view.unmount())
    error.mockRestore()
})
it('paints a saved bracket answer immediately on remount while the next read is pending', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    await act(async () => view.unmount())
    state.getBracket.mockReturnValue(new Promise(() => {}))
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    expect(view.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(0)
    expect(view.root.findAllByProps({ children: 'No playoff bracket yet' })[0].props.children).toBe('No playoff bracket yet')
    await act(async () => view.unmount())
})

it('dismisses the bracket when returning to standings', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    await act(async () => view.root.findByType('ModalScreen' as React.ElementType).props.onBack())
    expect(state.dismissTo).toHaveBeenCalledExactlyOnceWith('/league?tab=results')
    expect(state.replace).not.toHaveBeenCalled()
    await act(async () => view.unmount())
})
