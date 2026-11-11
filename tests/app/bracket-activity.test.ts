import { clearPersistentCaches } from '@/lib/persistent-cache'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { LeaguePlayoffs } from '@/components/league/LeaguePlayoffs'
import type { StandingRow } from '@/lib/scoring'
import LegacyBracketScreen from '@/app/(modals)/bracket'

function BracketScreen() { return React.createElement(LeaguePlayoffs, { standings: [], playoffEntrants: 4 }) }

const state = vi.hoisted(() => ({ active: true, epoch: 0, getBracket: vi.fn(), dismissTo: vi.fn(), replace: vi.fn(), push: vi.fn() }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => {
    const gate = { canRead: () => state.active, capture: () => state.epoch,
        isCurrent: (epoch: number) => state.active && epoch === state.epoch }
    return { useDraftActivity: () => ({ ...gate, epoch: state.epoch }) }
})
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 1200, height: 900 }) }))
vi.mock('expo-router', () => ({ Redirect: 'Redirect', Stack: { Screen: () => null }, useRouter: () => ({ replace: state.replace, dismissTo: state.dismissTo, push: state.push }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))
vi.mock('@/components/ui/Badge', () => ({ Badge: 'Badge' }))
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
    expect(view.root.findAllByProps({ children: 'Playoff projection unavailable' })).toHaveLength(0)
    state.active = true; state.epoch += 1
    await act(async () => view.update(React.createElement(BracketScreen)))
    expect(state.getBracket).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByProps({ children: 'Playoff projection unavailable' })).toHaveLength(1)
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
    expect(view.root.findAllByProps({ children: 'Playoff projection unavailable' })[0].props.children).toBe('Playoff projection unavailable')
    expect(view.root.findAll(node => node.props['aria-busy'] === true)).toHaveLength(1)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => fail(new Error('offline')))
    expect(view.root.findAllByProps({ children: 'Playoff projection unavailable' })[0].props.children).toBe('Playoff projection unavailable')
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
    expect(view.root.findAllByProps({ children: 'Playoff projection unavailable' })[0].props.children).toBe('Playoff projection unavailable')
    await act(async () => view.unmount())
})

it('redirects old bracket links into League Playoffs', async () => {
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(LegacyBracketScreen)) })
    expect(view.root.findByType('Redirect' as React.ElementType).props.href).toBe('/league?tab=bracket')
    expect(state.getBracket).not.toHaveBeenCalled()
    await act(async () => view.unmount())
})

it('opens the selected playoff matchup from its card', async () => {
    const matchup = { id: 'semifinal-1', round: 'semifinal', weekNumber: 20, homeId: 'member', homeName: 'Owls', homePoints: 12, awayId: 'other', awayName: 'Foxes', awayPoints: 9, winnerId: null, isFinalized: false }
    state.getBracket.mockResolvedValue({ quarterfinals: [], semifinals: [matchup], final: null, champion: null })
    let view!: ReactTestRenderer
    await act(async () => { view = create(React.createElement(BracketScreen)) })
    try {
        const button = view.root.findByProps({ accessibilityLabel: 'Open Owls versus Foxes' })
        expect(button.props.accessibilityRole).toBe('button')
        await act(async () => button.props.onPress())
        expect(state.push).toHaveBeenCalledExactlyOnceWith('/matchup?matchupId=semifinal-1')
    } finally {
        await act(async () => view.unmount())
    }
})

it('shows labeled projections inline and switches to actual cards after standings refresh', async () => {
    const standings: StandingRow[] = Array.from({ length: 4 }, (_, index) => ({ memberId: `team-${index}`, teamName: `Team ${index}`, wins: 4 - index, losses: index, ties: 0, pointsFor: 100, maxPointsFor: 200, pointsAgainst: 100 }))
    const render = (rows: StandingRow[]) => React.createElement(LeaguePlayoffs, { standings: rows, playoffEntrants: 4 })
    let view!: ReactTestRenderer
    await act(async () => { view = create(render(standings)) })
    expect(view.root.findAllByProps({ children: 'Projected bracket — based on current standings' })).toHaveLength(1)
    expect(view.root.findAllByProps({ children: '4 playoff teams · 0 first-round byes' })).toHaveLength(1)
    expect(view.root.findAllByType('ModalScreen' as React.ElementType)).toHaveLength(0)
    expect(view.root.findAllByType('MotionPressable' as React.ElementType)).toHaveLength(0)
    state.getBracket.mockResolvedValue({ quarterfinals: [], semifinals: [], final: { id: 'actual', round: 'final', weekNumber: 20, homeId: 'member', homeName: 'Owls', homePoints: 12, awayId: 'other', awayName: 'Foxes', awayPoints: 9, winnerId: null, isFinalized: false }, champion: null })
    await act(async () => view.update(render([...standings])))
    expect(view.root.findAllByProps({ children: 'Projected bracket — based on current standings' })).toHaveLength(0)
    expect(view.root.findByProps({ accessibilityLabel: 'Open Owls versus Foxes' })).toBeTruthy()
    await act(async () => view.unmount())
})
