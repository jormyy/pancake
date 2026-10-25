import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { PlayerHeader } from '@/components/player/PlayerHeader'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { ReadOnlyRosterPlayerItem } from '@/components/roster/RosterItems'
import { AssetList } from '@/components/trades/TradeCard'
import { playerRow, rosterPlayer } from '../helpers/fixtures'

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const labels = (screen: ReactTestRenderer) => screen.root.findAllByType('Badge' as React.ElementType).map(node => node.props.label)
const render = async (child: React.ReactNode, slots = 2) => {
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(PlayerEligibilityContext.Provider, { value: slots }, child)) })
    return screen
}

it.each([[0, null, 2, ['Rookie', 'Taxi']], [2, 64, 2, ['Taxi']], [0, 90, 0, ['Rookie']], [null, null, 2, []], [1, 65, 2, []]] as const)('tags experience %s and games %s with %s slots', async (years, games, slots, expected) => {
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
    expect(labels(screen).filter(label => label === 'Taxi')).toHaveLength(3)
    expect(labels(screen).filter(label => label === 'Rookie')).toHaveLength(2)
    expect(labels(screen)).not.toContain('IR')
    await act(async () => screen.unmount())
})
