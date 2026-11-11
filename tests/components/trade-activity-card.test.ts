import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeCard } from '@/components/trades/TradeCard'
import { trade } from '../helpers/fixtures'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
import { tradePlayerDetailRoute } from '@/components/player/navigation'
import { playerHeadshotUrl } from '@/lib/format'
import type { TransactionRow } from '@/lib/transactions'


const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => navigation }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, StyleSheet: { create: (styles: unknown) => styles },
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Pressable' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge', InjuryBadge: 'InjuryBadge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn(), API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@shopify/flash-list', () => ({ FlashList: 'FlashList' }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'UTC' }))
vi.mock('@/hooks/use-player-age', () => ({ usePlayerAge: () => null }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))

const item: TransactionRow = {
    id: 'completed', memberId: 'a', targetMemberId: 'b', teamName: 'Owls', targetTeamName: 'Foxes',
    playerId: null, playerName: 'Trade completed', position: null, eligiblePositions: [], nbaId: null,
    transactionType: 'trade_completed', isSystem: true, occurredAt: '2026-11-10T12:00:00Z',
    title: 'Trade completed', body: 'Long trade summary that the compact card replaces.',
    participantTeamNames: ['Owls', 'Foxes'],
    tradePlayers: [
        { kind: 'player', playerId: 'low', playerName: 'Low', tradeValue: 100, nbaId: '123', position: 'PG', nbaTeam: 'BOS', eligiblePositions: ['PG'], fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
        { kind: 'player', playerId: 'high', playerName: 'High', tradeValue: 900, nbaId: '456', position: 'C', nbaTeam: 'DEN', eligiblePositions: ['C'], fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
    ],
    tradePicks: [
        { kind: 'pick', pickId: 'r2', seasonYear: 2027, round: 2, originalTeamName: 'Foxes', fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
        { kind: 'pick', pickId: 'r1-later', seasonYear: 2029, round: 1, originalTeamName: 'Foxes', fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
        { kind: 'pick', pickId: 'r1', seasonYear: 2028, round: 1, originalTeamName: 'Foxes', fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
        { kind: 'pick', pickId: 'earliest', seasonYear: 2027, round: 1, originalTeamName: 'Foxes', fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
        { kind: 'pick', pickId: 'other', seasonYear: 2028, round: 1, originalTeamName: 'Owls', fromMemberId: 'a', toMemberId: 'b', fromTeamName: 'Owls', toTeamName: 'Foxes' },
    ],
}
const trees: ReactTestRenderer[] = []
afterEach(async () => {
    await act(async () => trees.splice(0).forEach(tree => tree.unmount()))
    navigation.push.mockClear()
})
async function renderRow(event = item, myMemberId?: string) {
    let feed!: ReactTestRenderer
    let row!: ReactTestRenderer
    await act(async () => { feed = create(React.createElement(ActivityFeed, { transactions: [event], myMemberId })) })
    trees.push(feed)
    const renderItem = feed.root.findByType('FlashList' as React.ElementType).props.renderItem
    await act(async () => { row = create(renderItem({ item: event })) })
    trees.push(row)
    return row
}

function renderedAssets(tree: ReactTestRenderer) {
    return tree.root.findAll(node => node.type === ('Text' as React.ElementType)
        && (node.props.testID === 'player-name-line' || /^\d{4} Round /.test(node.props.accessibilityLabel ?? '')))
        .map(node => React.Children.toArray(node.props.children).join(''))
}

it('shows a two-team trade with players first and picks ordered by year then round', async () => {
    const row = await renderRow()
    expect(row.root.findAllByProps({ testID: 'trade-activity-completed' })).toHaveLength(1)
    const texts = row.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts).toContain('Owls receives')
    expect(texts).toContain('Foxes receives')
    expect(texts).not.toContain(item.body)
    const avatars = row.root.findAllByType('Avatar' as React.ElementType)
    expect(avatars.map(node => node.props.uri)).toEqual([playerHeadshotUrl('456'), playerHeadshotUrl('123')])
    const links = row.root.findAllByType('Pressable' as React.ElementType)
    expect(links.map(node => node.props.accessibilityLabel)).toEqual(['View High stats', 'View Low stats'])
    const assetText = JSON.stringify(row.toJSON())
    expect(assetText).not.toContain(' — from ')
    expect(assetText).toContain('2028 Round 1 (orig. Foxes)')
    expect(renderedAssets(row)).toEqual([
        'High', 'Low', '2027 Round 1 (orig. Foxes)', '2027 Round 2 (orig. Foxes)',
        '2028 Round 1 (orig. Foxes)', '2029 Round 1 (orig. Foxes)', '2028 Round 1 (orig. Owls)',
    ])
    expect(row.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join(''))).toContain('R1')
    await act(async () => links[0].props.onPress())
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(tradePlayerDetailRoute({ playerId: 'high', name: 'High', nbaId: '456', team: 'DEN', positions: ['C'] }))
})

it('shows a three-team trade with players first and picks ordered by year then round', async () => {
    const row = await renderRow({ ...item, participantTeamNames: ['Owls', 'Foxes', 'Bears'], tradePlayers: [
        ...item.tradePlayers!,
        { ...item.tradePlayers![0], playerId: 'third', playerName: 'Third', fromMemberId: 'a', toMemberId: 'c', fromTeamName: 'Owls', toTeamName: 'Bears' },
    ], tradePicks: [
        ...item.tradePicks!,
        { kind: 'pick', pickId: 'bears-pick', seasonYear: 2028, round: 1, originalTeamName: 'Bears', fromMemberId: 'c', toMemberId: 'a', fromTeamName: 'Bears', toTeamName: 'Owls' },
    ] }, 'a')
    const labels = row.root.findAllByType('Text' as React.ElementType).map(node => node.props.accessibilityLabel).filter(Boolean)
    expect(labels).toContain('2028 Round 1 (orig. Bears)')
    expect(labels.every(label => !label.includes(' — from '))).toBe(true)
    expect(renderedAssets(row)).toEqual([
        'High', 'Low', '2027 Round 1 (orig. Foxes)', '2027 Round 2 (orig. Foxes)',
        '2028 Round 1 (orig. Foxes)', '2028 Round 1 (orig. Bears)', '2029 Round 1 (orig. Foxes)',
        '2028 Round 1 (orig. Owls)', 'Third',
    ])
    const text = JSON.stringify(row.toJSON())
    for (const team of ['Owls', 'Foxes', 'Bears']) expect(text).toContain(team)
    expect(text.match(/gets/g)).toHaveLength(3)
    expect(row.root.findAllByType('Pressable' as React.ElementType)).toHaveLength(3)
})


it('shows the exchanged amounts for a FAAB-only trade', async () => {
    const row = await renderRow({ ...item, body: null, tradePlayers: [], tradePicks: [], tradeFaab: [
        { kind: 'faab', amount: 12, fromMemberId: 'a', toMemberId: 'b', fromTeamName: 'Owls', toTeamName: 'Foxes' },
        { kind: 'faab', amount: 8, fromMemberId: 'b', toMemberId: 'a', fromTeamName: 'Foxes', toTeamName: 'Owls' },
    ] })
    const text = JSON.stringify(row.toJSON())
    expect(text).toContain('FAAB')
    expect(text).toContain('12')
    expect(text).toContain('8')
    expect(text).not.toContain('Nothing')
})


it('keeps legacy trades honest when asset details are missing', async () => {
    const row = await renderRow({ ...item, body: null, tradePlayers: [], tradePicks: [] })
    const text = JSON.stringify(row.toJSON())
    expect(text).toContain('Owls')
    expect(text).toContain('Foxes')
    expect(text).toContain('Trade asset details are unavailable.')
    expect(text).not.toContain('Nothing')
})


it('keeps Trades tab cards ordered by round then year', async () => {
    const offer = trade({ proposerMemberId: 'b', proposerTeamName: 'Foxes', recipientMemberId: 'a', recipientTeamName: 'Owls',
        routedItems: [
            ...item.tradePlayers!.map(player => ({ ...player, position: player.position ?? null, nbaTeam: player.nbaTeam ?? null })),
            ...item.tradePicks!.map(pick => ({ ...pick, fromMemberId: pick.fromMemberId!, toMemberId: pick.toMemberId! })),
        ],
    })
    let card!: ReactTestRenderer
    await act(async () => { card = create(React.createElement(TradeCard, {
        trade: offer, myMemberId: 'a', tab: 'history', acting: false,
        onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onAnalyze: vi.fn(),
    })) })
    trees.push(card)
    expect(renderedAssets(card)).toEqual([
        'High', 'Low', '2027 Round 1 (orig. Foxes)', '2028 Round 1 (orig. Foxes)',
        '2029 Round 1 (orig. Foxes)', '2027 Round 2 (orig. Foxes)', '2028 Round 1 (orig. Owls)',
    ])
})
