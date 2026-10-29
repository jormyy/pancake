import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { AssetList, TradeCard, tradeFlowItem } from '@/components/trades/TradeCard'
import { tradeAcceptanceSummary } from '@/components/trades/acceptance-summary'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { MultiTeamTradeOverview } from '@/components/trades/MultiTeamTradeOverview'
import { TradePickLabel } from '@/components/trades/TradePickLabel'
import { ActivityFeed } from '@/components/league/LeagueActivityFeed'
import { tradePickLabel, tradePickContext } from '@/lib/trade-pick-label'
import type { TransactionRow } from '@/lib/transactions'
import { trade } from '../../helpers/fixtures'

vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: null, loaded: false }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: null }) }))
vi.mock('@/components/trades/TradeReviewCancellation', () => ({ TradeReviewCancellation: () => null }))
vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/components/trades/ParticipantTradePanel', () => ({ ParticipantTradePanel: () => null }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: React.PropsWithChildren) => children }))
vi.mock('@/components/ui', () => ({ usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ useScreenStatusScroll: () => ({ contentStyle: () => ({}) }) }))
vi.mock('@shopify/flash-list', () => ({ FlashList: ({ data, renderItem }: { data: TransactionRow[]; renderItem: (props: { item: TransactionRow }) => React.ReactNode }) => data.map(item => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))) }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/components/Motion', () => ({ MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Pressable', props, children) }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'PlayerRowContent' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

afterEach(async () => { await act(async () => screen?.unmount()) })

const picks = [
        { kind: 'pick' as const, pickId: '66937c0f-20b3-4c14-aee0-63334f4c9f4d', seasonYear: 2029, round: 1, originalTeamName: "Mike's Minions", fromMemberId: 'mike', toMemberId: 'matthew' },
        { kind: 'pick' as const, pickId: '4165e18b-051d-4a9a-bba0-88d4c2ca9669', seasonYear: 2028, round: 2, originalTeamName: "Mike's Minions", fromMemberId: 'mike', toMemberId: 'matthew' },
]

it('identifies Matthew’s incoming picks without calling their original owner You', async () => {
    await act(async () => { screen = create(React.createElement(AssetList, { items: picks, label: 'You receive', pickContext: { viewerMemberId: 'matthew', memberNames: { mike: "Mike's Minions", matthew: 'Matthew' } } })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join('\n')
    expect(text).toContain("2028 Round 1 (orig. Mike's Minions)")
    expect(text).toContain("2027 Round 2 (orig. Mike's Minions)")
    expect(text.match(/from Mike's Minions → to You/g)).toHaveLength(2)
})

it.each(['pending', 'completed'] as const)('uses the same component in a %s card and review panel', async status => {
    const offer = trade({ status, proposerMemberId: 'matthew', proposerTeamName: 'Matthew', recipientMemberId: 'mike', recipientTeamName: "Mike's Minions", routedItems: picks })
    const actions = { acting: false, onAccept: vi.fn(), onReject: vi.fn(), onWithdraw: vi.fn(), onVeto: vi.fn() }
    await act(async () => { screen = create(React.createElement(React.Fragment, null,
        React.createElement(TradeCard, { trade: offer, myMemberId: 'matthew', tab: status === 'pending' ? 'offers' : 'history', ...actions, onAnalyze: vi.fn() }),
        React.createElement(TradeDetailsPanel, { context: { trade: offer, myMemberId: 'matthew', tab: status === 'pending' ? 'offers' : 'history' }, actions, onAnalyze: vi.fn() }),
    )) })
    const labels = screen.root.findAllByType(TradePickLabel).map(node => tradePickLabel(node.props.pick, node.props.context))
    expect(labels).toHaveLength(4)
    expect(labels.slice(0, 2)).toEqual(labels.slice(2))
    expect(labels).toContain("2028 Round 1 (orig. Mike's Minions) — from Mike's Minions → to You")
})

it('uses the same component for submitted summaries, multi-team review, and activity', async () => {
    const offer = trade({ proposerMemberId: 'matthew', proposerTeamName: 'Matthew', recipientMemberId: 'mike', recipientTeamName: "Mike's Minions", routedItems: picks })
    const context = tradePickContext(offer, 'matthew')
    const participants = ['matthew', 'mike'].map(memberId => ({ memberId, destinationIds: [memberId === 'mike' ? 'matthew' : 'mike'], defaultDestinationId: memberId === 'mike' ? 'matthew' : 'mike', roster: [], picks: memberId === 'mike' ? picks : [], selectedPlayerIds: new Set<string>(), selectedPickIds: new Set(memberId === 'mike' ? picks.map(pick => pick.pickId) : []), playerDestinationIds: {}, pickDestinationIds: {}, faabInputs: {} }))
    const callback = vi.fn()
    const activity: TransactionRow = { id: 'activity', memberId: 'matthew', teamName: 'Matthew', playerId: null, playerName: 'Trade completed', position: null, eligiblePositions: [], nbaId: null, transactionType: 'trade_completed', occurredAt: '2026-10-27T20:39:13Z', isSystem: true, tradePicks: picks.map(pick => ({ ...pick, fromTeamName: "Mike's Minions", toTeamName: 'Matthew' })) }
    await act(async () => { screen = create(React.createElement(React.Fragment, null,
        React.createElement(MultiTeamTradeBuilder, { participants, items: picks, myMemberId: 'matthew', faabEnabled: false, notesError: null, expirationError: null, rosterError: null, rosterLoading: false, avgMap: new Map(), avgStatsMap: new Map(), participantName: id => context.memberNames[id], reviewOnly: true, showTerms: false, onRetry: callback, onTogglePlayer: callback, onTogglePick: callback, onRemoveAsset: callback, onDestinationChange: callback, onPlayerDestinationChange: callback, onPickDestinationChange: callback, onFaabChange: callback }),
        React.createElement(MultiTeamTradeOverview, { participants: [{ memberId: 'matthew', label: 'You' }, { memberId: 'mike', label: "Mike's Minions" }], items: picks.flatMap((pick, index) => tradeFlowItem(pick, index) ?? []), pickContext: context }),
        React.createElement(ActivityFeed, { transactions: [activity], myMemberId: 'matthew' }),
    )) })
    const labels = screen.root.findAllByType(TradePickLabel).map(node => tradePickLabel(node.props.pick, node.props.context))
    expect(labels).toHaveLength(6)
    expect(labels.slice(0, 2)).toEqual(labels.slice(2, 4))
    expect(labels.slice(0, 2)).toEqual(labels.slice(4))
    expect(labels[0]).toBe("2028 Round 1 (orig. Mike's Minions) — from Mike's Minions → to You")
})

it('keeps the full pick label in the acceptance confirmation', () => {
    const offer = trade({ proposerMemberId: 'matthew', proposerTeamName: 'Matthew', recipientMemberId: 'mike', recipientTeamName: "Mike's Minions", routedItems: picks })
    expect(tradeAcceptanceSummary(offer, [], 'matthew')).toContain("2028 Round 1 (orig. Mike's Minions) — from Mike's Minions → to You")
})
