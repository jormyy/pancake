import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MatchupLineupView } from '@/components/MatchupLineupView'
import { matchupDailyTotal } from '@/lib/matchup-daily-total'
import type { LiveStatLine } from '@/lib/games'
import type { LineupPlayer, LineupSlot } from '@/lib/lineup'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@/components/Motion', () => ({ LivePulse: 'LivePulse', MotionPressable: 'MotionPressable', MotionView: 'MotionView' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:60521/functions/v1/api' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = (id: string): LineupPlayer => ({
    rosterPlayerId: id, playerId: id, displayName: id, position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'TOR', injuryStatus: null, nbaId: null,
})
const starter = (id: string): LineupSlot => ({ slotType: 'PG', player: player(id) })
const line = (changes: Partial<LiveStatLine> = {}): LiveStatLine => ({
    points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0, threeMade: 0,
    fgMade: 0, fgAttempted: 0, ftMade: 0, ftAttempted: 0, fouls: 0, doubleDouble: false,
    tripleDouble: false, minutesPlayed: 0, didNotPlay: false, ...changes,
})
const settings = { points: 1, rebounds: 1.5, assists: 2, turnovers: -1, double_double: 3 }
let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it('sums only starter stat lines with the league scoring settings', () => {
    const stats = new Map([
        ['first', line({ points: 12, rebounds: 3, assists: 4, turnovers: 2 })],
        ['second', line({ points: 10, rebounds: 10, doubleDouble: true })],
        ['bench', line({ points: 99 })],
        ['out', line({ points: 99, didNotPlay: true })],
    ])
    expect(matchupDailyTotal([starter('first'), starter('second'), starter('out'), starter('missing'), { slotType: 'C', player: null }], stats, settings)).toBe(50.5)
})

it.each([
    [[], new Map<string, LiveStatLine>(), null],
    [[starter('missing')], new Map<string, LiveStatLine>(), null],
    [[starter('out')], new Map([['out', line({ didNotPlay: true })]]), null],
    [[starter('zero')], new Map([['zero', line()]]), 0],
    [[starter('negative')], new Map([['negative', line({ turnovers: 3 })]]), -3],
] as const)('distinguishes missing or DNP lines from zero and negative scores: %s', (starters, stats, expected) => {
    expect(matchupDailyTotal(starters, stats, settings)).toBe(expected)
})

const props = (): React.ComponentProps<typeof MatchupLineupView> => ({
    playerForecasts: new Map(), forecastStale: false, myMemberId: 'my-team', opponentMemberId: 'their-team',
    myLineup: { starters: [starter('Mine'), starter('Other')], bench: [player('Bench player')], ir: [], taxi: [] },
    oppLineup: { starters: [starter('Theirs'), starter('Out')], bench: [], ir: [], taxi: [] },
    selected: null, getTargetState: () => null, onTap: vi.fn(), saving: false,
    playingTeams: new Set(['TOR']), liveTeams: new Set(['TOR']), scoringSettings: settings,
    liveStats: new Map([
        ['Mine', line({ points: 12, assists: 2 })], ['Other', line({ points: 3, rebounds: 3 })],
        ['Theirs', line({ turnovers: 2 })], ['Out', line({ didNotPlay: true })], ['Bench player', line({ points: 99 })],
    ]),
    teamMatchups: new Map(), statColumns: null, onOpenDetails: vi.fn(), onOpenPlayer: vi.fn(),
    capacity: { bench: 1, ir: 0, taxi: 0 }, compact: true, dense: true,
})
const totals = () => ['left', 'right'].map(side => screen.root.findByProps({ testID: `matchup-daily-total-${side}` }).props.children)

it('puts one band after the starters and before the bench, with matching row totals', async () => {
    await act(async () => { screen = create(React.createElement(MatchupLineupView, props())) })
    expect(screen.root.findAllByProps({ testID: 'matchup-daily-total' })).toHaveLength(1)
    expect(totals()).toEqual(['23.5', '-2.0'])
    const texts = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts.indexOf('Daily Total')).toBeGreaterThan(texts.indexOf('Out'))
    expect(texts.indexOf('Daily Total')).toBeLessThan(texts.indexOf('Bench'))
    expect(texts).toContain('16.0')
    expect(texts).toContain('7.5')
    expect(texts).toContain('99.0')
})

it('updates both sides with score revisions, selected-day data, and starter moves', async () => {
    const initial = props()
    await act(async () => { screen = create(React.createElement(MatchupLineupView, initial)) })
    const revised = new Map(initial.liveStats).set('Mine', line({ points: 20 })).set('Theirs', line())
    await act(async () => screen.update(React.createElement(MatchupLineupView, { ...initial, liveStats: revised })))
    expect(totals()).toEqual(['27.5', '0.0'])
    const moved = { ...initial.myLineup, starters: [starter('Bench player'), starter('Other')], bench: [player('Mine')] }
    await act(async () => screen.update(React.createElement(MatchupLineupView, { ...initial, liveStats: revised, myLineup: moved })))
    expect(totals()).toEqual(['106.5', '0.0'])
    await act(async () => screen.update(React.createElement(MatchupLineupView, { ...initial, liveStats: new Map(), liveTeams: new Set<string>() })))
    expect(totals()).toEqual(['—', '—'])
    const past = new Map([['Mine', line({ points: 8 })], ['Theirs', line({ points: 17 })]])
    await act(async () => screen.update(React.createElement(MatchupLineupView, { ...initial, liveStats: past, liveTeams: new Set<string>() })))
    expect(totals()).toEqual(['8.0', '17.0'])
})
