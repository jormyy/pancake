import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MatchupRow } from '@/components/MatchupRow'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@/components/Motion', () => ({ LivePulse: 'LivePulse', MotionPressable: 'MotionPressable', MotionView: 'MotionView' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:57121/functions/v1/api' }))
vi.mock('@/lib/scoring', () => ({ computeLiveFantasyPoints: () => 0 }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each([['Gary Trent Jr.', 'G. Trent', '1629018'], ['Jaren Jackson III', 'J. Jackson', 'IOS67'], ['Shai Gilgeous-Alexander', 'Gilgeous-A', null]])('keeps %s identifiable on a phone', async (displayName, expected, nbaId) => {
    await act(async () => {
        screen = create(React.createElement(MatchupRow, {
            myPlayer: { rosterPlayerId: 'roster', playerId: 'player', displayName, position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: null, nbaId },
            oppPlayer: null, slotType: 'PG', selKind: 'starter', selIndex: 0, isSelected: false, onTap: vi.fn(), saving: false,
            playingTeams: new Set<string>(), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map(), compact: true,
        }))
    })
    expect(screen.root.findAllByType('Avatar' as React.ElementType)).toHaveLength(1)
    expect(screen.root.findByType('Avatar' as React.ElementType).props.size).toBe(24)
    expect(screen.root.findByType('Avatar' as React.ElementType).props.uri).toBe(nbaId === '1629018' ? 'http://127.0.0.1:57121/functions/v1/api/players/headshot/1629018' : undefined)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === expected)).toBe(true)
})

const rowPlayer = (playerId: string, nbaTeam: string, injuryStatus: string | null = null) => ({ rosterPlayerId: playerId, playerId, displayName: playerId, position: 'PG', eligiblePositions: ['PG'], nbaTeam, injuryStatus, nbaId: null })
const rowProps = () => ({ myPlayer: rowPlayer('Mine', 'TOR', 'DTD'), oppPlayer: rowPlayer('Theirs', 'OKC', 'Out'), slotType: 'PG', selKind: 'starter' as const, selIndex: 0, isSelected: false, onTap: vi.fn(), saving: false, playingTeams: new Set(['TOR', 'OKC']), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map([['TOR', { opponent: 'OKC', isHome: false }], ['OKC', { opponent: 'TOR', isHome: true }]]), compact: true })

it('mirrors names and badges outward from the centre headshots', async () => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, props)) })
    const avatars = screen.root.findAllByType('Avatar' as React.ElementType)
    const order = avatars.map(avatar => avatar.parent!.parent!.parent!.children.filter(child => typeof child !== 'string').map(child => typeof child === 'string' ? child : child.type))
    expect(order[0]).toEqual(['InjuryBadge', 'Text', expect.any(Function)])
    expect(order[1]).toEqual([expect.any(Function), 'Text', 'InjuryBadge'])
    const names = screen.root.findAllByProps({ testID: 'matchup-player-name' })
    expect(names).toHaveLength(2)
    expect(names.every(node => node.props.numberOfLines === 1 && node.props.ellipsizeMode === 'clip')).toBe(true)
})

it('keeps earned points and game lines without per-player projections', async () => {
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...rowProps(), showProjections: true,
        myProjection: { gameId: 'g', playerId: 'Mine', memberId: 'm', date: '2026-10-25', projection: 23.4, source: 'Sleeper', sourceAt: null, remainingFraction: 1 },
    })) })
    const texts = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts.filter(value => value === 'TOR @ OKC')).toHaveLength(2)
    expect(texts.join(' ')).not.toContain('Proj')
    expect(texts.join(' ')).not.toContain('23.4')
})
