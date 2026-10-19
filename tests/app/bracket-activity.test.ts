import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import BracketScreen from '@/app/(modals)/bracket'

const state = vi.hoisted(() => ({ active: true, epoch: 0, getBracket: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => {
    const gate = { canRead: () => state.active, capture: () => state.epoch,
        isCurrent: (epoch: number) => state.active && epoch === state.epoch }
    return { useDraftActivity: () => ({ ...gate, epoch: state.epoch }) }
})
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 1200, height: 900 }) }))
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/lib/bracket', () => ({ getPlayoffBracket: state.getBracket }))
vi.mock('@/lib/format', () => ({ formatPoints: String }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui/ModalScreen', () => ({ ModalScreen: 'ModalScreen' }))
vi.mock('@/components/ui', () => ({ LoadingState: 'LoadingState', usePageMetrics: () => ({ padX: 16, usableWidth: 1200 }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => { vi.clearAllMocks(); state.active = true; state.epoch = 0; state.getBracket.mockResolvedValue(null) })
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
    expect(view.root.findAllByType('EmptyState' as React.ElementType)).toHaveLength(0)
    state.active = true; state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    expect(state.getBracket).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByType('EmptyState' as React.ElementType)).toHaveLength(1)
    await act(async () => view.unmount())
})
