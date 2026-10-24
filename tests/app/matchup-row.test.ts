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

it.each([['Gary Trent Jr.', 'Trent', '1629018'], ['Jaren Jackson III', 'Jackson', 'IOS67'], ['Derrick White 23', 'White', null]])('keeps %s identifiable on a phone', async (displayName, expected, nbaId) => {
    await act(async () => {
        screen = create(React.createElement(MatchupRow, {
            myPlayer: { rosterPlayerId: 'roster', playerId: 'player', displayName, position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: null, nbaId },
            oppPlayer: null, slotType: 'PG', selKind: 'starter', selIndex: 0, isSelected: false, onTap: vi.fn(), saving: false,
            playingTeams: new Set<string>(), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map(), compact: true,
        }))
    })
    expect(screen.root.findAllByType('Avatar' as React.ElementType)[0].props.uri).toBe(nbaId === '1629018' ? 'http://127.0.0.1:57121/functions/v1/api/players/headshot/1629018' : undefined)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === expected)).toBe(true)
})
