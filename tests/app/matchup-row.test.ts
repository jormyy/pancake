import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
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
    // rowProps: Mine is DTD, Theirs is Out — each gets a tag on the headshot.
    expect(screen.root.findAllByProps({ testID: 'injury-tag' }).map(tag => [tag.props.children, tag.props.accessibilityLabel])).toEqual([['DTD', 'Day-To-Day'], ['OUT', 'Out']])
    const lines = screen.root.findAllByProps({ testID: 'matchup-game-line' })
    expect(lines.map(line => line.props.accessibilityLabel)).toEqual(['TOR @ OKC', 'OKC vs TOR'])
    // The game line shows the opponent's logo; the player's own logo sits beside their name.
    expect(lines.map(line => line.findAllByType('Image' as React.ElementType).map(logo => logo.props.accessibilityLabel))).toEqual([['OKC'], ['TOR']])
    expect(screen.root.findAllByProps({ testID: 'matchup-player-name' }).map(name => name.parent!.findAllByType('Image' as React.ElementType).map(logo => logo.props.accessibilityLabel))).toEqual([['TOR'], ['OKC']])
    for (const badge of screen.root.findAllByType('InjuryBadge' as React.ElementType)) {
        expect(badge.parent!.findAllByType('Text' as React.ElementType).some(node => ['Mine', 'Theirs'].includes(node.props.children))).toBe(true)
    }
    await act(async () => screen.update(React.createElement(MatchupRow, { ...props, playingTeams: new Set<string>(), teamMatchups: new Map<string, { opponent: string; isHome: boolean }>() })))
    expect(texts().join(' ')).not.toMatch(/TOR|OKC|OFF|No game/)
    // No game: no blank game line, so the name and photo centre in the row.
    expect(screen.root.findAllByProps({ testID: 'matchup-game-line' })).toHaveLength(0)
    // A player with no game scores a dash, not a zero.
    expect(texts().filter(text => text === '-')).toHaveLength(2)
    expect(texts()).not.toContain('0')
})

it('renders the game line and tip time together on the first row commit', async () => {
    const commits: string[][] = []
    const props = { ...rowProps(), myPlayer: rowPlayer('Mine', 'WAS'), oppPlayer: rowPlayer('Theirs', 'CLE'), teamMatchups: new Map([
        ['WAS', { opponent: 'CLE', isHome: false, gameTime: '2026-10-28T23:00:00Z', timezone: 'America/New_York', status: 'Scheduled' }],
        ['CLE', { opponent: 'WAS', isHome: true, gameTime: '2026-10-28T23:00:00Z', timezone: 'America/New_York', status: 'Scheduled' }],
    ]) }
    await act(async () => {
        screen = create(React.createElement(React.Profiler, { id: 'row', onRender: () => commits.push(screen.root.findAllByProps({ testID: 'matchup-game-line' }).map(node => node.props.accessibilityLabel).filter((value): value is string => typeof value === 'string')) }, React.createElement(MatchupRow, props)))
    })
    expect(commits).toHaveLength(1)
    expect(commits[0].filter(text => / (vs|@) /.test(text))).toEqual(['WAS @ CLE 7:00 PM', 'CLE vs WAS 7:00 PM'])
})

it.each([true, false])('never shows lineup pin tags in matchup rows (compact=%s); pins live on Roster', async compact => {
    const props = rowProps()
    await act(async () => { screen = create(React.createElement(MatchupRow, {
        ...props, compact,
        myPlayer: { ...props.myPlayer, lineupPin: 'start' }, oppPlayer: { ...props.oppPlayer, lineupPin: 'bench' },
    })) })
    expect(screen.root.findAllByType('View' as React.ElementType).filter(node => /^Pinned to /.test(String(node.props.accessibilityLabel)))).toHaveLength(0)
})

it('bolds only scores from finished games, not live or upcoming ones', async () => {
    const props = { ...rowProps(), myPlayer: rowPlayer('Mine', 'TOR'), oppPlayer: rowPlayer('Theirs', 'OKC'), liveTeams: new Set(['OKC']), teamMatchups: new Map([
        ['TOR', { opponent: 'BOS', isHome: false, status: 'Final' }],
        ['OKC', { opponent: 'DEN', isHome: true, status: 'InProgress' }],
    ]) }
    await act(async () => { screen = create(React.createElement(MatchupRow, props)) })
    const weight = (name: string) => [screen.root.findByProps({ accessibilityLabel: `Score breakdown for ${name}` }).findByType('Text' as React.ElementType).props.style].flat(Infinity)
        .reduce((current: string | undefined, style: { fontWeight?: string } | false | null) => style && style.fontWeight ? style.fontWeight : current, undefined)
    expect(weight('Mine')).toBe('800')
    expect(weight('Theirs')).toBe('500')
    await act(async () => screen.update(React.createElement(MatchupRow, { ...props, teamMatchups: new Map([['TOR', { opponent: 'BOS', isHome: false, status: 'Scheduled' }], ['OKC', { opponent: 'DEN', isHome: true, status: 'Final' }]]) })))
    expect(weight('Mine')).toBe('500')
    expect(weight('Theirs')).toBe('800')
})

it.each([['PG', true], ['C', true], ['UTIL', true], ['IR', true], ['BE', false], ['TX', false]])('weights the %s slot label heavier: %s, on the same faint tint', async (slotType, strong) => {
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...rowProps(), slotType })) })
    const chip = screen.root.findAllByType('MotionPressable' as React.ElementType).find(node => String(node.props.accessibilityLabel).startsWith(`Select ${slotType} slot`))!
    const fill = Object.assign({}, ...[chip.props.style].flat(Infinity).filter(Boolean)).backgroundColor
    const label = Object.assign({}, ...[chip.findByType('Text' as React.ElementType).props.style].flat(Infinity).filter(Boolean))
    expect(fill).toMatch(/rgba|color-mix/)
    expect(label.fontWeight).toBe(strong ? '900' : '800')
})

it('keeps read-only slot chips at full color instead of the faded disabled look', async () => {
    const chip = () => screen.root.findAllByType('MotionPressable' as React.ElementType).find(node => String(node.props.accessibilityLabel).startsWith('Select PG slot'))!
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...rowProps(), readOnly: true })) })
    expect(chip().props.disabled).toBe(true)
    expect(chip().props.disabledOpacity).toBe(1)
    await act(async () => screen.update(React.createElement(MatchupRow, { ...rowProps(), saving: true })))
    expect(chip().props.disabled).toBe(true)
    expect(chip().props.disabledOpacity).toBeUndefined()
})

it.each([
    ['Scheduled', false, undefined, '-'],
    ['InProgress', true, undefined, '0'],
    ['Final', false, undefined, '0'],
    ['Scheduled', false, { didNotPlay: true }, '0'],
])('shows a dash until the game starts (%s, live %s)', async (status, live, stats, expected) => {
    const props = { ...rowProps(), myPlayer: rowPlayer('Mine', 'TOR'), oppPlayer: null, liveTeams: new Set(live ? ['TOR'] : []),
        liveStats: new Map(stats ? [['Mine', stats]] : []),
        teamMatchups: new Map([['TOR', { opponent: 'OKC', isHome: false, status }]]) }
    await act(async () => { screen = create(React.createElement(MatchupRow, props as unknown as React.ComponentProps<typeof MatchupRow>)) })
    expect(screen.root.findByProps({ accessibilityLabel: 'Score breakdown for Mine' }).findByType('Text' as React.ElementType).props.children).toBe(expected)
})

it.each([true, false])('centres an empty slot on a single line (compact=%s)', async compact => {
    await act(async () => { screen = create(React.createElement(MatchupRow, { ...rowProps(), oppPlayer: null, compact })) })
    const body = screen.root.findByProps({ accessibilityLabel: 'No starter' })
    expect(body.findAllByType('Text' as React.ElementType)).toHaveLength(1)
    expect(Object.assign({}, ...[body.props.style].flat(Infinity).filter(Boolean)).justifyContent).toBe('center')
})
