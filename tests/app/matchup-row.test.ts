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

it.each([['Gary Trent Jr.', 'G. Trent Jr.', '1629018'], ['Jaren Jackson III', 'J. Jackson III', 'IOS67'], ['Shai Gilgeous-Alexander', 'S. Gilgeous-Alexander', null]])('keeps %s identifiable on a phone', async (displayName, expected, nbaId) => {
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

it.each(['1629018', 'IOS67', null])('retains valid headshots on wide rows: %s', async nbaId => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...props, myPlayer: { ...props.myPlayer, nbaId }, compact: false })) })
    expect(screen.root.findAllByType('Avatar' as React.ElementType)[0].props.uri).toBe(nbaId === '1629018' ? 'http://127.0.0.1:57121/functions/v1/api/players/headshot/1629018' : undefined)
})

it('keeps profiles, scores and lineup selection independent', async () => {
    const props = rowProps(), onOpenPlayer = vi.fn(), onOpenDetails = vi.fn()
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...props, onOpenPlayer, onOpenDetails })) })
    const press = async (label: string) => act(async () => screen.root.findByProps({ accessibilityLabel: label }).props.onPress())
    await press('Open Mine player profile')
    await press('Open Theirs player profile')
    expect(onOpenPlayer.mock.calls).toEqual([[props.myPlayer], [props.oppPlayer]])
    expect(onOpenDetails).not.toHaveBeenCalled()
    expect(props.onTap).not.toHaveBeenCalled()
    await press('Score breakdown for Mine')
    await press('Score breakdown for Theirs')
    expect(onOpenDetails).toHaveBeenCalledTimes(2)
    expect(onOpenPlayer).toHaveBeenCalledTimes(2)
    expect(props.onTap).not.toHaveBeenCalled()
    await press('Select PG slot, Mine')
    expect(props.onTap).toHaveBeenCalledExactlyOnceWith({ kind: 'starter', index: 0 })
})

it('keeps injuries beside names and games visible without no-game team text', async () => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, props)) })
    const texts = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts().filter(text => text === 'TOR @ OKC')).toHaveLength(2)
    for (const badge of screen.root.findAllByType('InjuryBadge' as React.ElementType)) {
        expect(badge.parent!.findAllByType('Text' as React.ElementType).some(node => ['Mine', 'Theirs'].includes(node.props.children))).toBe(true)
    }
    await act(async () => screen.update(React.createElement(MatchupRow, { ...props, playingTeams: new Set(), teamMatchups: new Map() })))
    expect(texts().join(' ')).not.toMatch(/TOR|OKC|OFF|No game/)
})
