import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeBlockListingRow } from '@/components/trades/TradeListRow'
import { StandingsTable } from '@/components/league/LeagueStandings'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import type { TradeBlockItem } from '@/lib/trades'
import { playerRow } from '../helpers/fixtures'

vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/components/trades/TradeCard', () => ({ TradeCard: 'TradeCard' }))
vi.mock('@/hooks/use-unsent-form-update', () => ({ useUnsentFormUpdate: () => undefined }))
vi.mock('@/hooks/use-jersey-number', () => ({ useJerseyNumber: () => null }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/projections', () => ({ formatProjectionGame: () => null }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 16, usableWidth: 343 }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))

const TEAM = 'Every kingdom needs its Castle and moat!'
const PLAYER = 'Giannis Antetokounmpo-Longername Jr. II'

let screen: ReactTestRenderer | null = null
afterEach(async () => {
    if (screen) await act(async () => { screen?.unmount() })
    screen = null
})

const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
const textNode = (root: ReactTestInstance, text: string) =>
    root.findAll(node => node.type === 'Text' && React.Children.toArray(node.props.children).join('') === text)[0]

async function render(element: React.ReactElement) {
    await act(async () => { screen = create(element) })
    return screen!.root
}

it('keeps the trade block name on one line beside Note and Remove', async () => {
    const listing: TradeBlockItem = {
        id: 'listing', memberId: 'me', teamName: TEAM, updatedAt: '', note: 'Looking for a first-round pick and a starter',
        asset: { kind: 'player', playerId: 'giannis', playerName: PLAYER, position: 'PF', nbaTeam: 'MIL' },
    }
    const root = await render(React.createElement(TradeBlockListingRow, {
        item: { _type: 'blockItem', item: listing }, myMemberId: 'me', blockBusyId: null, onRemove: vi.fn(), onSaveNote: vi.fn(),
    }))
    expect(textNode(root, PLAYER).props.numberOfLines).toBe(1)
    for (const label of [`Edit trade block note for ${PLAYER}`, `Remove ${PLAYER} from trade block`]) {
        expect(flat(root.findByProps({ accessibilityLabel: label }).props.style).flexShrink).toBe(0)
    }
})

it('keeps a standings team name on one line and its scores whole', async () => {
    const root = await render(React.createElement(StandingsTable, {
        standings: [{ memberId: 'a', teamName: TEAM, wins: 10, losses: 12, ties: 1, pointsFor: 1638.4, pointsAgainst: 1592.6, maxPointsFor: 1702.2 }],
        onSelectTeam: vi.fn(),
    }))
    const name = textNode(root, TEAM)
    expect(name.props.numberOfLines).toBe(1)
    expect(flat(name.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 })
    for (const value of ['1638', '10-12-1']) {
        const cell = textNode(root, value)
        expect(cell.props.numberOfLines).toBe(1)
        expect(flat(cell.props.style).flexShrink).toBe(0)
    }
})

it('keeps a player search name on one line beside a fixed Add button', async () => {
    const root = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ display_name: PLAYER }), currentMemberId: 'me', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false,
        animate: false, onAdd: vi.fn(), onPress: vi.fn(),
    }))
    const name = root.findByProps({ testID: 'player-name-line' })
    expect(name.props.children).toBe(PLAYER)
    expect(name.props.numberOfLines).toBe(1)
    const add = root.findAllByProps({ accessibilityLabel: `Claim ${PLAYER}` })[0]
    expect(flat(add.parent!.props.style).flexShrink).toBe(0)
})
