import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ScoreBreakdownSheet } from '@/components/ScoreBreakdownSheet'
import type { LineupPlayer } from '@/lib/lineup'
import type { LiveStatLine } from '@/lib/games'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles } }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })
const player: LineupPlayer = {
    rosterPlayerId: 'roster', playerId: 'player', displayName: 'Player One', position: 'PG',
    eligiblePositions: ['PG'], nbaTeam: 'BOS', nbaId: null, injuryStatus: null,
}
const zeroStats: LiveStatLine = {
    points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, threeMade: 0,
    fgMade: 0, fgAttempted: 0, ftMade: 0, ftAttempted: 0, fouls: 0,
    doubleDouble: false, tripleDouble: false, minutesPlayed: 1, didNotPlay: false,
}
const props = { visible: true, onClose: vi.fn(), slotType: 'PG', settings: { points: 1, rebounds: 1.2 }, mine: { player }, theirs: { player } }
const texts = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)

it('shows compact scoring rules until either player has stats, including a zero score', async () => {
    await act(async () => { screen = create(React.createElement(ScoreBreakdownSheet, props)) })
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Scoring rules' })).toHaveLength(1)
    expect(texts()).toEqual(expect.arrayContaining(['Points', '+1 each', 'Rebounds', '+1.2 each']))
    expect(texts()).not.toContain('Stat')
    expect(texts()).not.toContain('FP')
    expect(texts()).not.toContain('–')
    await act(async () => screen.update(React.createElement(ScoreBreakdownSheet, { ...props, mine: { player, stats: zeroStats } })))
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Scoring rules' })).toHaveLength(0)
    expect(texts()).toContain('Stat')
    expect(texts()).toContain('FP')
    expect(screen.root.findByProps({ testID: 'score-breakdown-total' }).props.children).toBe('0.0')
    expect(texts()).toContain(0)
    expect(texts()).toContain('0')
})
