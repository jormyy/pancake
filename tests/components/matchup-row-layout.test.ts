import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MatchupRow } from '@/components/MatchupRow'

vi.mock('react-native', () => ({ Image: 'Image', Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 402, height: 874 }) }))
vi.mock('@/components/Motion', () => ({ LivePulse: 'LivePulse', MotionPressable: 'MotionPressable', MotionView: 'MotionView' }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:57121/functions/v1/api' }))
vi.mock('@/lib/scoring', () => ({ computeLiveFantasyPoints: () => 0 }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each([['Gary Trent Jr.', 'G. Trent', '1629018'], ['Jaren Jackson III', 'J. Jackson', 'IOS67'], ['Shai Gilgeous-Alexander', 'S. Gilgeous…', null]])('keeps %s identifiable on a phone', async (displayName, expected, nbaId) => {
    await act(async () => {
        screen = create(React.createElement(MatchupRow, {
            myPlayer: { rosterPlayerId: 'roster', playerId: 'player', displayName, position: 'PG', eligiblePositions: ['PG'], nbaTeam: null, injuryStatus: null, nbaId },
            oppPlayer: null, slotType: 'PG', selKind: 'starter', selIndex: 0, isSelected: false, onTap: vi.fn(), saving: false,
            playingTeams: new Set<string>(), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map(), compact: true,
        }))
    })
    expect(screen.root.findAllByType('Avatar' as React.ElementType)).toHaveLength(1)
    // As tall as the 16px name line, 2px gap and 16px game line; the image sits inside a 1px border.
    expect(flatStyle(screen.root.findByProps({ testID: 'matchup-player-avatar' }).props.style)).toMatchObject({ width: 34, height: 34 })
    expect(screen.root.findByType('Avatar' as React.ElementType).props.size).toBe(32)
    expect(screen.root.findByType('Avatar' as React.ElementType).props.uri).toBe(nbaId === '1629018' ? 'http://127.0.0.1:57121/functions/v1/api/players/headshot/1629018' : undefined)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === expected)).toBe(true)
})

const rowPlayer = (playerId: string, nbaTeam: string, injuryStatus: string | null = null) => ({ rosterPlayerId: playerId, playerId, displayName: playerId, position: 'PG', eligiblePositions: ['PG'], nbaTeam, injuryStatus, nbaId: null })
const rowProps = () => ({ myPlayer: rowPlayer('Mine', 'TOR', 'DTD'), oppPlayer: rowPlayer('Theirs', 'OKC', 'Out'), slotType: 'PG', selKind: 'starter' as const, selIndex: 0, isSelected: false, onTap: vi.fn(), saving: false, playingTeams: new Set(['TOR', 'OKC']), liveStats: new Map(), liveTeams: new Set<string>(), scoringSettings: {}, teamMatchups: new Map([['TOR', { opponent: 'OKC', isHome: false }], ['OKC', { opponent: 'TOR', isHome: true }]]), compact: true })

it('mirrors names and badges outward from the centre headshots', async () => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, props)) })
    const avatars = screen.root.findAllByType('Avatar' as React.ElementType)
    // Each side is [name + game line, headshot], mirrored so both headshots face the slot chip.
    const sides = avatars.map(avatar => avatar.parent!.parent!.parent!.parent!.children.filter(child => typeof child !== 'string').map(child => typeof child === 'string' ? child : child.type))
    expect(sides[0]).toEqual(['View', expect.any(Function)])
    expect(sides[1]).toEqual([expect.any(Function), 'View'])
    const nameRows = screen.root.findAllByProps({ testID: 'matchup-player-name' }).map(name => name.parent!.children.filter(child => typeof child !== 'string').map(child => typeof child === 'string' ? child : child.type))
    // Injury badges sit on the outer edge; the team logo is always right of the name.
    expect(nameRows).toEqual([['InjuryBadge', 'Text', expect.any(Function)], ['Text', expect.any(Function), 'InjuryBadge']])
    const names = screen.root.findAllByProps({ testID: 'matchup-player-name' })
    expect(names).toHaveLength(2)
    expect(names.every(node => node.props.adjustsFontSizeToFit && node.props.numberOfLines === 1 && node.props.ellipsizeMode === 'clip')).toBe(true)
    const detail = screen.root.findAllByProps({ testID: 'matchup-game-line' })
    expect(Number(flatStyle(names[0].props.style).fontWeight)).toBeGreaterThan(Number(flatStyle(detail[0].findAllByType('Text' as React.ElementType)[0].props.style).fontWeight))
})

const flatStyle = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
it.each([true, false])('reserves two fixed lines for game and no-game players at compact=%s', async compact => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...props, compact, teamMatchups: new Map([['TOR', { opponent: 'OKC', isHome: false }]]) })) })
    const bodies = screen.root.findAllByType('MotionPressable' as React.ElementType).filter(node => String(node.props.accessibilityLabel).startsWith('Open '))
    expect(bodies).toHaveLength(2)
    expect(bodies.map(node => flatStyle(node.props.style).height)).toEqual([56, 56])
    const textColumns = bodies.map(node => node.findByProps({ testID: 'matchup-player-text' }))
    expect(textColumns.map(column => column.children.length)).toEqual([2, 2])
    expect(textColumns.map(column => (column.children as ReactTestInstance[]).map(line => flatStyle(line.props.style).height))).toEqual([[16, 16], [16, 16]])
    const scores = screen.root.findAllByType('MotionPressable' as React.ElementType).filter(node => String(node.props.accessibilityLabel).startsWith('Score breakdown'))
    expect(scores.every(node => flatStyle(node.props.style).justifyContent === 'center')).toBe(true)
})

it('separates matchup rows with the shared border tokens', async () => {
    await act(async () => { screen = create(React.createElement(MatchupRow, rowProps())) })
    const { borderWidth, colors } = await import('@/constants/tokens')
    expect(screen.root.findAllByType('View' as React.ElementType).some(node => JSON.stringify(node.props.style).includes(`"borderBottomColor":"${colors.separator}"`) && JSON.stringify(node.props.style).includes(`"borderBottomWidth":${borderWidth.thin}`))).toBe(true)
})

it.each([
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'Scheduled', null, ' 4:00 PM'],
    ['2026-10-28T23:00:42Z', 'America/New_York', 'Scheduled', null, ' 7:00 PM'],
    ['2026-01-28T00:00:42Z', 'America/Los_Angeles', 'Scheduled', null, ' 4:00 PM'],
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'Final', 'Final', ' Final'],
    [null, 'America/Los_Angeles', 'Final', null, ' Final'],
    [null, 'America/Los_Angeles', 'Scheduled', null, ''],
    ['invalid', 'America/Los_Angeles', 'Scheduled', null, ''],
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'InProgress', 'Q3 5:23', ' Q3'],
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'InProgress', 'Halftime', ' Half'],
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'InProgress', 'OT1 2:00', ' OT'],
    ['2026-10-28T23:00:42Z', 'America/Los_Angeles', 'InProgress', 'OT3 0:41', ' 3OT'],
])('shows the player team first, then tip time, live period or Final (%s, %s, %s, %s)', async (gameTime, timezone, status, statusText, suffix) => {
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...rowProps(), timezone,
        teamMatchups: new Map([['TOR', { opponent: 'OKC', isHome: false, gameTime, status, statusText }], ['OKC', { opponent: 'TOR', isHome: true, gameTime, status, statusText }]]),
    })) })
    const texts = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    const lines = screen.root.findAllByProps({ testID: 'matchup-game-line' })
    expect(lines.map(line => line.props.accessibilityLabel)).toEqual([`TOR @ OKC${suffix}`, `OKC vs TOR${suffix}`])
    expect(lines.every(line => line.findAllByType('Image' as React.ElementType).length === 1)).toBe(true)
    // The game line is a centred row ("@", logo, time) so the logo sits level with the text; the time shrinks and clips to fit.
    expect(lines.every(line => String(line.type) === 'View' && flatStyle(line.props.style).alignItems === 'center')).toBe(true)
    const times = lines.flatMap(line => line.findAllByType('Text' as React.ElementType).filter(node => node.props.adjustsFontSizeToFit))
    expect(times).toHaveLength(suffix ? 2 : 0)
    expect(times.every(time => time.props.ellipsizeMode === 'clip' && flatStyle(time.props.style).textOverflow === 'clip' && time.props.children === suffix.trim())).toBe(true)
    expect(texts.join(' ')).not.toMatch(/Age |Yr /)
})

it.each([
    ['Q1 11:34', 'Q1'], ['q4 0:00.0', 'Q4'], ['End of 2nd Qtr', 'Q2'], ['End Q3', 'Q3'], ['Half', 'Half'], ['Halftime', 'Half'],
    ['OT 2:00', 'OT'], ['OT1 2:00', 'OT'], ['OT2 1:04', '2OT'], ['2OT 1:04', '2OT'], ['3OT', '3OT'],
    ['Final', null], ['', null], [null, null], ['7:00 pm ET', null],
])('reads the live period from %s', async (text, expected) => {
    const { gamePeriodLabel } = await import('@/components/MatchupRow')
    expect(gamePeriodLabel(text)).toBe(expected)
})
