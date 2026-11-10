import { navigation } from '../../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradePlayerLink } from '@/components/trades/TradePlayerLink'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { TradeCard } from '@/components/trades/TradeCard'
import { readPlayerHeader, tradePlayerDetailRoute } from '@/components/player/navigation'
import { rosterPlayer, trade } from '../../helpers/fixtures'

const state = vi.hoisted(() => ({ locks: [] as unknown[], loaded: true }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'mine' }, currentLeague: { id: 'league' } }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: state.loaded ? { locks: state.locks } : null }) }))
vi.mock('@/lib/trades', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/trades')>(), readTradeAssetLocks: () => state.locks }))
vi.mock('@/hooks/use-player-age', () => ({ usePlayerAge: () => null }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'UTC' }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))
const push = navigation.push
let tree: ReactTestRenderer

afterEach(async () => {
    if (tree) await act(async () => tree.unmount())
    push.mockClear()
    state.locks = []
    state.loaded = true
})

it('passes the identity as an existing player page header without a pickup action', () => {
    const identity = { playerId: 'p', name: 'Player', nbaId: '123', team: 'BOS', positions: ['PG'], yearsExp: 2, careerGames: 100, injuryStatus: 'Out' }
    const route = tradePlayerDetailRoute(identity)
    expect(route.pathname).toBe('/player/[id]')
    expect(route.params.id).toBe('p')
    expect(readPlayerHeader('p', route.params.playerHeader)).toMatchObject({ id: 'p', display_name: 'Player', nba_id: '123', nba_team: 'BOS', eligible_positions: ['PG'], years_exp: 2, career_regular_season_games: 100, injury_status: 'Out' })
    expect(route.params).not.toHaveProperty('pickupHint')
})

it('opens a player with no stats from the name, photo, and row press target', async () => {
    await act(async () => { tree = create(React.createElement(TradePlayerLink, { playerId: 'p', name: 'No stats' })) })
    const targets = tree.root.findAllByType('Pressable' as React.ElementType)
    expect(targets).toHaveLength(1)
    expect(targets[0].props.accessibilityLabel).toBe('View No stats stats')
    expect(targets[0].findAllByProps({ testID: 'player-row-avatar' })).toHaveLength(1)
    await act(async () => targets[0].props.onPress())
    expect(push).toHaveBeenCalledExactlyOnceWith(tradePlayerDetailRoute({ playerId: 'p', name: 'No stats' }))
})

async function column(selected = false, blocked = false) {
    const toggle = vi.fn()
    const player = rosterPlayer()
    await act(async () => { tree = create(React.createElement(TradeAssetColumn, {
        memberId: 'mine', title: 'Send', subtitle: 'You', side: 'give', twoColumn: false, roster: [player], picks: [],
        avgMap: new Map(), avgStatsMap: new Map(), selectedPlayerIds: new Set(selected ? [player.players.id] : []),
        selectedPickIds: new Set<string>(), blockedPlayerIds: new Set(blocked ? [player.players.id] : []),
        onTogglePlayer: toggle, onTogglePick: vi.fn(), emptyText: '', testIdPrefix: 'trade-mine',
    })) })
    return { toggle, player, buttons: tree.root.findAllByType('Pressable' as React.ElementType) }
}

it.each([false, true])('keeps stats and selection separate when selected is %s', async selected => {
    const { toggle, player, buttons } = await column(selected)
    expect(buttons).toHaveLength(2)
    const [stats, select] = buttons
    expect(stats.props.accessibilityLabel).toBe(`View ${player.players.display_name} stats`)
    expect(select.props.accessibilityLabel).toBe(`${selected ? 'Remove' : 'Add'} ${player.players.display_name} ${selected ? 'from' : 'to'} trade`)
    expect(select.props.accessibilityState).toEqual({ selected, disabled: false })
    expect(select.props.testID).toBe(`trade-mine-player-${player.players.id}`)
    expect(stats.findAllByType('Pressable' as React.ElementType)).toHaveLength(1)
    await act(async () => stats.props.onPress())
    expect(toggle).not.toHaveBeenCalled()
    push.mockClear()
    await act(async () => select.props.onPress())
    expect(toggle).toHaveBeenCalledExactlyOnceWith(player.players.id)
    expect(push).not.toHaveBeenCalled()
})

it.each(['checking', 'locked', 'routed'])('keeps stats available while selection is %s', async reason => {
    if (reason === 'checking') state.loaded = false
    if (reason === 'locked') state.locks = [{ assetKind: 'player', assetId: rosterPlayer().players.id, reason: 'Game locked', sourceKind: 'trade', sourceId: 'offer' }]
    const { buttons } = await column(false, reason === 'routed')
    const stats = buttons.find(button => button.props.accessibilityLabel?.startsWith('View '))!
    const select = buttons.find(button => button.props.testID?.startsWith('trade-mine-player-'))!
    expect(select.props.disabled).toBe(true)
    expect(stats.props.disabled).not.toBe(true)
    await act(async () => stats.props.onPress())
    expect(push).toHaveBeenCalledTimes(1)
})

it('retains the details control without enclosing any player controls', async () => {
    const open = vi.fn()
    const offer = trade({ routedItems: [{ kind: 'player', playerId: 'p', playerName: 'Player', position: null, nbaTeam: null, fromMemberId: 'member-a', toMemberId: 'member-b' }] })
    await act(async () => { tree = create(React.createElement(TradeCard, {
        trade: offer, myMemberId: offer.proposerMemberId, tab: 'offers', acting: false,
        onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onAnalyze: vi.fn(), onOpen: open,
    })) })
    const details = tree.root.findAllByType('Pressable' as React.ElementType).find(button => button.props.testID === `trade-details-${offer.id}`)!
    expect(details.props.accessibilityLabel).toContain('Show details of trade with ')
    expect(details.findAllByType('Pressable' as React.ElementType)).toHaveLength(1)
    await act(async () => details.props.onPress())
    expect(open).toHaveBeenCalledTimes(1)
})
