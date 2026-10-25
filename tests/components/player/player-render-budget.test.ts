import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { GameLogTable } from '@/components/player/GameLogTable'
import type { GameLogEntry } from '@/lib/players'

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable',
    Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@/components/ui/useEdgeFade', () => ({ useEdgeFade: () => ({}) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

it('keeps unchanged game lines out of unrelated renders and still accepts new stats', async () => {
    const formatDate = vi.spyOn(Date.prototype, 'toLocaleDateString')
    const game: GameLogEntry = {
        gameId: 'game', gameDate: '2026-10-24', opponent: 'vs LAL', isHome: true, didNotPlay: false,
        minutes: 30, points: 20, rebounds: 6, assists: 5, steals: 1, blocks: 1, turnovers: 2,
        personalFouls: 2, fgMade: 7, fgAttempted: 15, threeMade: 3, threeAttempted: 7,
        ftMade: 3, ftAttempted: 4, plusMinus: 4, doubleDouble: false, tripleDouble: false,
    }
    const props = { games: [game], fantasyPointsMap: null, hasMore: false, loadingMore: false, onLoadMore: vi.fn() }
    await act(async () => { screen = create(React.createElement(GameLogTable, props)) })
    const before = formatDate.mock.calls.length
    expect(before).toBeGreaterThan(0)
    await act(async () => screen.update(React.createElement(GameLogTable, { ...props })))
    expect(formatDate).toHaveBeenCalledTimes(before)
    await act(async () => screen.update(React.createElement(GameLogTable, { ...props, games: [{ ...game, points: 31 }] })))
    expect(formatDate.mock.calls.length).toBeGreaterThan(before)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 31)).toBe(true)
})

it('retains a recent-game row when a new stat record describes the same NBA game', async () => {
    const game = {
        gameId: 'first-stat', nbaGameId: 'nba-game', gameDate: '2026-10-24', opponent: 'vs LAL', isHome: true, didNotPlay: false,
        minutes: 30, points: 20, rebounds: 6, assists: 5, steals: 1, blocks: 1, turnovers: 2,
        personalFouls: 2, fgMade: 7, fgAttempted: 15, threeMade: 3, threeAttempted: 7,
        ftMade: 3, ftAttempted: 4, plusMinus: 4, doubleDouble: false, tripleDouble: false,
    }
    const props = { games: [game], fantasyPointsMap: new Map([[game.gameId, 35]]), hasMore: false, loadingMore: false, onLoadMore: vi.fn() }
    await act(async () => { screen = create(React.createElement(GameLogTable, props)) })
    const row = () => screen.root.findAllByType('Text' as React.ElementType).find(node => node.props.children === 20)!.parent
    const before = row()
    await act(async () => screen.update(React.createElement(GameLogTable, {
        ...props, games: [{ ...game, gameId: 'second-stat' }], fantasyPointsMap: new Map([['second-stat', 35]]),
    })))
    expect(row()).toBe(before)
    await act(async () => screen.update(React.createElement(GameLogTable, {
        ...props, games: [{ ...game, gameId: 'second-stat', points: 21 }], fantasyPointsMap: new Map([['second-stat', 36]]),
    })))
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 21)).toBe(true)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === '36.0')).toBe(true)
})
