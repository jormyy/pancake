import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { compactBadgeTokens } from '@/components/ui/Badge'
import { palette } from '@/constants/tokens'
import { Badge, InjuryBadge } from '@/components/Badge'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { ReadOnlyRosterPlayerItem } from '@/components/roster/RosterItems'
import { RosterPlayerSheet } from '@/components/roster/RosterPlayerSheet'
import { clearSessionCaches, setSessionOwner } from '@/lib/session-cache-registry'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import type { TradeItem } from '@/lib/trades'
import { AssetList, tradeFlowItem } from '@/components/trades/TradeCard'
import { playerRow, rosterPlayer } from '../helpers/fixtures'
vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', () => ({ Image: 'Image', View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Motion', () => ({ MotionView: 'View', MotionPressable: 'Pressable' }))
const jerseyQueries = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ in: jerseyQueries.read }) }) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children }: React.PropsWithChildren) => React.createElement('View', null, children) }))

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const details = (screen: ReactTestRenderer) => screen.root.findAllByProps({ testID: 'player-meta-line' }).map(row => row.findAllByType('Text' as React.ElementType).map(node => node.props.children).join(''))
const labels = (screen: ReactTestRenderer) => screen.root.findAllByType(Badge).map(node => node.props.label)
const render = async (child: React.ReactNode, slots = 2) => {
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(PlayerEligibilityContext.Provider, { value: slots }, child)) })
    return screen
}

it.each([[0, null, 2], [0, 65, 2], [2, 0, 2], [2, 64, 2], [0, 90, 0], [null, null, 2], [1, 65, 2]] as const)('keeps player rows free of status badges for experience %s and games %s with %s slots', async (years, games, slots) => {
    const screen = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ years_exp: years, career_regular_season_games: games }),
        currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {},
    }), slots)
    expect(screen.root.findByProps({ testID: 'player-meta-line' }).findAllByType(Badge)).toHaveLength(0)
    await act(async () => screen.unmount())
})

it('shows no eligibility badges on the player page header, roster or trade rows', async () => {
    const source = rosterPlayer().players
    const child = React.createElement(React.Fragment, null,
        React.createElement(PlayerHeader, { player: { ...source, years_exp: 0, career_regular_season_games: null, jersey_number: null, dynasty_rank: null, headshot_url: null }, rosterStatus: null, leagueActive: true }),
        React.createElement(ReadOnlyRosterPlayerItem, { item: rosterPlayer({ players: { ...source, years_exp: 1, career_regular_season_games: 64 } }), onPress: () => {} }),
        React.createElement(AssetList, { items: [{ kind: 'player', playerId: 'trade', playerName: 'Trade', nbaTeam: 'BOS', position: 'PG', yearsExp: 0 }], label: 'Assets' }),
    )
    const screen = await render(child)
    expect(labels(screen).filter(label => label.startsWith('T:') || label === 'R')).toHaveLength(0)
    await act(async () => screen.unmount())
})

it('shows team, roles, and jersey number on the second line, and injuries on the headshot', async () => {
    const screen = await render(React.createElement(PlayerRowContent, {
        name: 'A very long player name', team: 'LAL', positions: ['PG', 'SG'], jerseyNumber: '15', yearsExp: 0, careerGames: 3, birthdate: '2001-10-29', injuryStatus: 'Out',
    }))
    expect(details(screen)).toEqual(['LAL · PG, SG · #15'])
    const metadata = screen.root.findByProps({ testID: 'player-meta-line' })
    expect(metadata.findAllByType(Badge)).toHaveLength(0)
    expect(metadata.findAllByProps({ testID: 'team-logo' })).toHaveLength(1)
    expect(screen.root.findByProps({ testID: 'player-name-line' }).props.children).toBe('A very long player name')
    expect(screen.root.findByProps({ testID: 'player-row-avatar' }).findByProps({ testID: 'injury-tag' }).props.accessibilityLabel).toBe('Out')
    await act(async () => screen.unmount())
})

it('skips unknown parts of the second line', async () => {
    const screen = await render(React.createElement(React.Fragment, null,
        React.createElement(PlayerRowContent, { name: 'No team', positions: ['C'], jerseyNumber: null }),
        React.createElement(PlayerRowContent, { name: 'No number', team: 'BOS', positions: [], jerseyNumber: null }),
    ))
    expect(details(screen)).toEqual(['C', 'BOS'])
    await act(async () => screen.unmount())
})

it.each([['Out', 'OUT', 'Out', palette.red600], ['OUT', 'OUT', 'Out', palette.red600], [' gtd ', 'DTD', 'Day-To-Day', palette.amber600], ['Day-To-Day', 'DTD', 'Day-To-Day', palette.amber600], ['DTD', 'DTD', 'Day-To-Day', palette.amber600]])('marks injury %s with a %s tag on the header headshot instead of a badge', async (status, text, label, color) => {
    const screen = await render(React.createElement(PlayerHeader, {
        player: { ...rosterPlayer().players, injury_status: status, years_exp: 2, career_regular_season_games: 100, jersey_number: null, dynasty_rank: null, headshot_url: null },
        rosterStatus: null, leagueActive: true,
    }))
    expect(screen.root.findAllByType(Badge).map(tag => tag.props.label)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(O|DTD)$/)]))
    const tag = screen.root.findByProps({ testID: 'injury-tag' })
    expect(tag.props.children).toBe(text)
    expect(tag.props.accessibilityLabel).toBe(label)
    expect(Object.assign({}, ...[tag.props.style].flat().filter(Boolean))).toMatchObject({ backgroundColor: color })
    await act(async () => screen.unmount())
})

it.each([['IR', 'IR', 'Injured reserve', palette.red600], ['ir', 'IR', 'Injured reserve', palette.red600]])('marks injury %s with a %s tag on the header headshot', async (status, text, label, color) => {
    const screen = await render(React.createElement(PlayerHeader, {
        player: { ...rosterPlayer().players, injury_status: status, years_exp: 2, career_regular_season_games: 100, jersey_number: null, dynasty_rank: null, headshot_url: null },
        rosterStatus: null, leagueActive: true,
    }))
    expect(labels(screen)).not.toContain('IR')
    const tag = screen.root.findByProps({ testID: 'injury-tag' })
    expect(tag.props.children).toBe(text)
    expect(tag.props.accessibilityLabel).toBe(label)
    expect(Object.assign({}, ...[tag.props.style].flat().filter(Boolean))).toMatchObject({ backgroundColor: color })
    await act(async () => screen.unmount())
})

it('keeps every desktop statistic inside the third player line', async () => {
    const screen = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ avg_fantasy_points: 51, avg_minutes_played: 32, avg_points: 23, avg_rebounds: 6, avg_assists: 7, avg_steals: 2, avg_blocks: 1, avg_three_pointers_made: 4, avg_turnovers: 5, games_played: 19 }),
        currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, showStats: true, onAdd: () => {}, onPress: () => {},
    }))
    const stats = screen.root.findByProps({ testID: 'player-stats-line' })
    expect(stats.findAllByType('Text' as React.ElementType)).toHaveLength(10)
    await act(async () => screen.unmount())
})

it.each([64, 65, null])('leaves taxi career counts off roster rows, the preview and the header: %s', async games => {
    const source = { ...rosterPlayer().players, years_exp: 2, career_regular_season_games: games }
    const child = React.createElement(React.Fragment, null,
        React.createElement(ReadOnlyRosterPlayerItem, { item: rosterPlayer({ is_on_taxi: true, players: source }), onPress: () => {} }),
        React.createElement(PlayerHeader, { player: { ...source, jersey_number: null, dynasty_rank: null, headshot_url: null }, rosterStatus: { status: 'mine', rosterPlayerId: 'roster', isOnTaxi: true }, leagueActive: true }),
        React.createElement(RosterPlayerSheet, { player: rosterPlayer({ is_on_taxi: true, players: source }), actions: [], onClose: () => {} }),
    )
    const screen = await render(child)
    expect(labels(screen).filter(label => label.startsWith('T:'))).toHaveLength(0)
    await act(async () => screen.unmount())
})

it.each(['Day-To-Day', 'day-to-day', 'DTD', 'dtd', 'GTD', ' gtd ', 'Out', 'OUT', 'IR', 'ir'])('renders no badge for %s, which shows as a headshot tag', async status => {
    const screen = await render(React.createElement(InjuryBadge, { status }))
    expect(screen.root.findAllByType(Badge)).toHaveLength(0)
    await act(async () => screen.unmount())
})


it('shows the same second line in the roster sheet, without age or experience', async () => {
    const source = rosterPlayer()
    source.players.birthdate = '2001-10-29'
    const screen = await render(React.createElement(RosterPlayerSheet, { player: source, actions: [], onClose: () => {} }))
    expect(labels(screen)).toEqual([])
    expect(details(screen)[0]).not.toMatch(/Yr|\b24\b/)
    await act(async () => screen.unmount())
})


it.each(['DTD', 'O', 'OUT', 'IR', 'R', 'T:1'])('renders %s below the game-line size with the compact token', async label => {
    const screen = await render(React.createElement(Badge, { label, size: 'compact' }))
    const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
    const text = screen.root.findByType('Text' as React.ElementType)
    const container = screen.root.findAllByType('View' as React.ElementType)[0]
    expect(flat(container.props.style).minHeight).toBe(compactBadgeTokens.minHeight)
    expect(flat(text.props.style).fontSize).toBe(compactBadgeTokens.fontSize)
    expect(compactBadgeTokens.minHeight).toBe(12)
    expect(compactBadgeTokens.fontSize).toBe(9)
    await act(async () => screen.unmount())
})


it('loads jersey numbers for trade cards, listings and routed trade rows', async () => {
    const { TradeBlockListingRow } = await import('@/components/trades/TradeListRow')
    const item: Extract<TradeItem, { kind: 'player' }> = { kind: 'player', playerId: 'trade', playerName: 'Trade player', nbaTeam: 'BOS', position: 'PG', yearsExp: 2, fromMemberId: 'me', toMemberId: 'other' }
    jerseyQueries.read.mockResolvedValue({ data: [{ id: 'trade', jersey_number: '7' }], error: null })
    setSessionOwner('jersey-surface-test')
    clearSessionCaches()
    try {
        const flow = tradeFlowItem(item, 0)!
        const screen = await render(React.createElement(React.Fragment, null,
            React.createElement(AssetList, { items: [item], label: 'Receive' }),
            React.createElement(TradeBlockListingRow, {
                item: { _type: 'blockItem', item: { id: 'listing', memberId: 'other', teamName: 'Other', asset: item, note: null, updatedAt: '2026-10-28T12:00:00Z' } },
                myMemberId: 'me', blockBusyId: null, onRemove: () => {}, onSaveNote: async () => true,
            }),
            React.createElement(PlayerRowContent, flow.player!),
        ))
        expect(details(screen).map(line => line.startsWith('BOS · PG · #7'))).toEqual([true, true, true])
        expect(jerseyQueries.read).toHaveBeenCalledWith('id', ['trade'])
        await act(async () => screen.unmount())
    } finally {
        setSessionOwner(null)
        clearSessionCaches()
    }
})
