import '../../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeCard } from '@/components/trades/TradeCard'
import type { RoutedTradeItem } from '@/lib/trades'
import { trade } from '../../helpers/fixtures'

vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: { id: 'member-a' }, currentLeague: { id: 'league' } }) }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: 'MultiTeamTradeOverview' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null, yearShort: String }))
vi.mock('@/lib/trades', () => ({ needsMemberAcceptance: () => false }))

let renderer: ReactTestRenderer | null = null
afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

const player = (playerId: string, fromMemberId: string, toMemberId: string) => ({ kind: 'player', playerId, playerName: playerId, fromMemberId, toMemberId,
    position: null, nbaTeam: null }) as RoutedTradeItem
const pick = (pickId: string, fromMemberId: string, toMemberId: string) => ({ kind: 'pick', pickId, seasonYear: 2027, round: 1, originalTeamName: 'Team C',
    fromMemberId, toMemberId }) as RoutedTradeItem
const draft = trade({ status: 'pending', isMultiTeam: true, completedAt: null,
    participants: ['member-a', 'member-b', 'member-c'].map((memberId, sortOrder) => ({ memberId, teamName: `Team ${memberId.slice(-1).toUpperCase()}`, sortOrder, isInitiator: sortOrder === 0, acceptedAt: null })),
    routedItems: [player('p1', 'member-a', 'member-b'), player('p2', 'member-b', 'member-a'), pick('k1', 'member-c', 'member-a'), pick('k2', 'member-a', 'member-c')] })

async function render(reviewMode?: 'propose' | 'accept') {
    await act(async () => {
        renderer = create(React.createElement(TradeCard, { trade: draft, myMemberId: 'member-a', tab: 'offers', acting: false, reviewMode,
            onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onAnalyze: vi.fn() }))
    })
    return renderer!
}

it('groups a proposal review by receiving team with each sender', async () => {
    const overview = (await render('propose')).root.findByType('MultiTeamTradeOverview' as React.ElementType)
    expect(overview.props.participants).toEqual([{ memberId: 'member-a', label: 'You' }, { memberId: 'member-b', label: 'Team B' }, { memberId: 'member-c', label: 'Team C' }])
    expect(overview.props.items.map((item: { fromMemberId: string; toMemberId: string; key: string }) => [item.key.split(':').slice(0, 2).join(':'), item.fromMemberId, item.toMemberId]))
        .toEqual([['player:p1', 'member-a', 'member-b'], ['player:p2', 'member-b', 'member-a'], ['pick:k1', 'member-c', 'member-a'], ['pick:k2', 'member-a', 'member-c']])
    expect(overview.props.showPickDirection).toBe(false)
    expect(renderer!.root.findAllByProps({ children: 'You receive' })).toHaveLength(0)
})

it('keeps the receive and give lists on other trade cards', async () => {
    const tree = await render('accept')
    expect(tree.root.findAllByType('MultiTeamTradeOverview' as React.ElementType)).toHaveLength(0)
    expect(tree.root.findAllByProps({ children: 'You receive' }).length).toBeGreaterThan(0)
})
