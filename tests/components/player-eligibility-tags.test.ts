import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { Badge } from '@/components/Badge'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { ReadOnlyRosterPlayerItem } from '@/components/roster/RosterItems'
import { RosterPlayerSheet } from '@/components/roster/RosterPlayerSheet'
import { AssetList } from '@/components/trades/TradeCard'
import { playerRow, rosterPlayer } from '../helpers/fixtures'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Motion', () => ({ MotionView: 'View', MotionPressable: 'Pressable' }))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children }: React.PropsWithChildren) => React.createElement('View', null, children) }))

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const labels = (screen: ReactTestRenderer) => screen.root.findAllByType(Badge).map(node => node.props.label)
const render = async (child: React.ReactNode, slots = 2) => {
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(PlayerEligibilityContext.Provider, { value: slots }, child)) })
    return screen
}

it.each([[0, null, 2, ['R', 'T:—']], [0, 65, 2, ['R', 'T:65']], [2, 0, 2, ['T:0']], [2, 64, 2, ['T:64']], [0, 90, 0, ['R']], [null, null, 2, []], [1, 65, 2, []]] as const)('tags experience %s and games %s with %s slots', async (years, games, slots, expected) => {
    const screen = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ years_exp: years, career_regular_season_games: games }),
        currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {},
    }), slots)
    expect(labels(screen)).toEqual(expected)
    await act(async () => screen.unmount())
})

it('places the same eligibility badges in the header, roster and trade asset rows', async () => {
    const source = rosterPlayer().players
    const child = React.createElement(React.Fragment, null,
        React.createElement(PlayerHeader, { player: { ...source, years_exp: 0, career_regular_season_games: null, jersey_number: null, dynasty_rank: null, headshot_url: null }, rosterStatus: null, leagueActive: true }),
        React.createElement(ReadOnlyRosterPlayerItem, { item: rosterPlayer({ players: { ...source, years_exp: 1, career_regular_season_games: 64 } }), onPress: () => {} }),
        React.createElement(AssetList, { items: [{ kind: 'player', playerId: 'trade', playerName: 'Trade', nbaTeam: 'BOS', position: 'PG', yearsExp: 0 }], label: 'Assets' }),
    )
    const screen = await render(child)
    expect(labels(screen).filter(label => label.startsWith('T:'))).toHaveLength(3)
    expect(labels(screen).filter(label => label === 'R')).toHaveLength(2)
    expect(labels(screen)).not.toContain('IR')
    await act(async () => screen.unmount())
})

it('keeps names separate from accessible abbreviated status tags', async () => {
    const screen = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ display_name: 'A very long player name', years_exp: 0, injury_status: 'Out' }),
        currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {},
    }))
    expect(labels(screen)).toEqual(['O', 'R', 'T:—'])
    const tags = screen.root.findAllByType(Badge)
    expect(tags.map(tag => tag.props.accessibilityLabel)).toEqual(['Out', 'Rookie', 'Taxi eligible, career games unknown'])
    const name = screen.root.findByProps({ testID: 'player-name-line' })
    expect(name.findAllByType(Badge)).toHaveLength(0)
    const metadata = screen.root.findByProps({ testID: 'player-meta-line' })
    expect(metadata.findAllByType(Badge)).toHaveLength(3)
    await act(async () => screen.unmount())
})

it.each([['Out', 'O', 'Out'], ['OUT', 'O', 'Out'], ['Day-To-Day', 'DTD', 'Day-To-Day'], ['DTD', 'DTD', 'Day-To-Day'], ['IR', 'IR', 'Injured reserve']])('labels injury %s as %s', async (status, text, accessibilityLabel) => {
    const screen = await render(React.createElement(PlayerHeader, {
        player: { ...rosterPlayer().players, injury_status: status, years_exp: 2, career_regular_season_games: 100, jersey_number: null, dynasty_rank: null, headshot_url: null },
        rosterStatus: null, leagueActive: true,
    }))
    const injury = screen.root.findAllByType(Badge).find(tag => tag.props.label === text)
    expect(injury?.props.accessibilityLabel).toBe(accessibilityLabel)
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

it.each([64, 65, null])('keeps a taxi occupant career count visible across roster, preview and detail: %s', async games => {
    const source = { ...rosterPlayer().players, years_exp: 2, career_regular_season_games: games }
    const child = React.createElement(React.Fragment, null,
        React.createElement(ReadOnlyRosterPlayerItem, { item: rosterPlayer({ is_on_taxi: true, players: source }), onPress: () => {} }),
        React.createElement(PlayerHeader, { player: { ...source, jersey_number: null, dynasty_rank: null, headshot_url: null }, rosterStatus: { status: 'mine', rosterPlayerId: 'roster', isOnTaxi: true }, leagueActive: true }),
        React.createElement(RosterPlayerSheet, { player: rosterPlayer({ is_on_taxi: true, players: source }), actions: [], onClose: () => {} }),
    )
    const screen = await render(child)
    const taxi = screen.root.findAllByType(Badge).filter(tag => tag.props.label.startsWith('T:'))
    expect(taxi.map(tag => tag.props.label)).toEqual(Array(3).fill(`T:${games ?? '—'}`))
    for (const tag of taxi) expect(tag.props.accessibilityLabel).toContain(games === 65 ? 'no longer eligible' : games === null ? 'eligibility unknown' : 'Taxi eligible')
    expect(labels(screen)).not.toContain('GP')
    await act(async () => screen.unmount())
})
