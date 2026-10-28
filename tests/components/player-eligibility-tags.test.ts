import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { compactBadgeTokens } from '@/components/ui/Badge'
import { INJURY_COLORS } from '@/constants/tokens'
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
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Motion', () => ({ MotionView: 'View', MotionPressable: 'Pressable' }))
const ageQueries = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ select: () => ({ in: ageQueries.read }) }) } }))
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
    expect(labels(screen)).toEqual([...expected, ...(years == null ? [] : [`Yr ${years + 1}`])])
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
    expect(labels(screen)).toEqual(['O', 'R', 'T:—', 'Yr 1'])
    const tags = screen.root.findAllByType(Badge)
    expect(tags.map(tag => tag.props.accessibilityLabel)).toEqual(['Out', 'Rookie', 'Taxi eligible, career games unknown', undefined])
    const name = screen.root.findByProps({ testID: 'player-name-line' })
    expect(name.findAllByType(Badge)).toHaveLength(0)
    const metadata = screen.root.findByProps({ testID: 'player-meta-line' })
    expect(metadata.findAllByType(Badge)).toHaveLength(4)
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

it.each(['Day-To-Day', 'day-to-day', 'DTD', 'dtd', 'GTD', ' gtd '])('renders %s with the shared red injury color', async status => {
    const screen = await render(React.createElement(InjuryBadge, { status }))
    const badge = screen.root.findByType(Badge)
    expect(badge.props.label).toBe('DTD')
    expect(badge.props.accessibilityLabel).toBe('Day-To-Day')
    expect(badge.props.color).toBe(INJURY_COLORS.Out)
    await act(async () => screen.unmount())
})


it('uses the same smaller token for every compact status badge', async () => {
    const screen = await render(React.createElement(PlayerSearchItem, {
        item: playerRow({ years_exp: 0, career_regular_season_games: 1, injury_status: 'DTD' }),
        currentMemberId: 'member', ownedMap: new Map(), waiverIds: new Set<string>(), isAdding: false, onAdd: () => {}, onPress: () => {},
    }))
    const badges = screen.root.findAllByType(Badge).filter(node => ['DTD', 'R', 'T:1'].includes(node.props.label))
    expect(badges).toHaveLength(3)
    expect(badges.map(node => node.props.size)).toEqual(['compact', 'compact', 'compact'])
    await act(async () => screen.unmount())
})

it('places known age immediately before experience in the roster sheet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
    try {
        const source = rosterPlayer()
        source.players.birthdate = '2001-10-29'
        const screen = await render(React.createElement(RosterPlayerSheet, { player: source, actions: [], onClose: () => {} }))
        const values = labels(screen)
        expect(values.slice(-2)).toEqual(['24', 'Yr 3'])
        await act(async () => screen.unmount())
    } finally { vi.useRealTimers() }
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


it('places age before experience in trade cards, listings and routed trade rows', async () => {
    const { TradeBlockListingRow } = await import('@/components/trades/TradeListRow')
    const item: Extract<TradeItem, { kind: 'player' }> = { kind: 'player', playerId: 'trade', playerName: 'Trade player', nbaTeam: 'BOS', position: 'PG', yearsExp: 2, fromMemberId: 'me', toMemberId: 'other' }
    ageQueries.read.mockResolvedValue({ data: [{ id: 'trade', birthdate: '2001-10-29' }], error: null })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
    setSessionOwner('age-surface-test')
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
        const rows = screen.root.findAllByProps({ testID: 'player-meta-line' })
        expect(rows).toHaveLength(3)
        expect(rows.map(row => row.findAllByType(Badge).map(badge => badge.props.label).slice(-2))).toEqual(Array(3).fill(['24', 'Yr 3']))
        expect(ageQueries.read).toHaveBeenCalledWith('id', ['trade'])
        await act(async () => screen.unmount())
    } finally {
        setSessionOwner(null)
        clearSessionCaches()
        vi.useRealTimers()
    }
})
