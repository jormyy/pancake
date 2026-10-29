import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PicksBankList } from '@/components/league/LeaguePicksBank'
import { RosterPickItem } from '@/components/roster/RosterItems'
import { TradeAssetColumn } from '@/components/trades/TradeAssetColumn'
import { AssetList } from '@/components/trades/TradeCard'
import { TradeBlockPickRow } from '@/components/trades/TradeListRow'

vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: null, currentLeague: null }) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/hooks/use-screen-view', () => ({ useScreenView: () => ({ data: null, loaded: false }) }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/ui/ScreenStatusOverlay', () => ({ ScreenStatusScrollView: 'ScrollView' }))
vi.mock('@/components/ui/SegmentedControl', () => ({ SegmentedControl: 'SegmentedControl' }))
vi.mock('@/components/ui/Page', () => ({ usePageMetrics: () => ({ padX: 16 }) }))
vi.mock('@/hooks/use-web-viewport', () => ({ useWebViewport: () => ({ viewportWidth: 402, viewportHeight: 874, compactLandscape: false }) }))
let screen: ReactTestRenderer
const pick = { kind: 'pick' as const, id: 'pick', pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'A', originalOwnerMemberId: 'a', currentTeamName: 'A', currentOwnerMemberId: 'a', isUsed: false }
const text = () => screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children).flat().join(' ')
afterEach(async () => { await act(async () => screen?.unmount()) })

it('shows the three NBA draft years and labels accessible pick rows', async () => {
    await act(async () => { screen = create(React.createElement(PicksBankList, { picks: [2028, 2029, 2030].map(seasonYear => ({ ...pick, id: String(seasonYear), seasonYear })) })) })
    for (const year of [2027, 2028, 2029]) expect(text()).toContain(`${year} R1`)
    expect(text()).not.toContain('2030')
    expect(screen.root.findAll(node => typeof node.props?.accessibilityLabel === 'string' && node.props?.accessibilityLabel.startsWith('2027 Round 1, from A')).length).toBeGreaterThan(0)
})

it('uses the NBA draft year in roster, trade, trade block and accessible selection labels', async () => {
    await act(async () => { screen = create(React.createElement(React.Fragment, null,
        React.createElement(RosterPickItem, { pick, myTeamName: 'A' }),
        React.createElement(AssetList, { items: [pick], label: 'You receive' }),
        React.createElement(TradeBlockPickRow, { item: { _type: 'blockPick', pick }, listed: false, busy: false, myTeamName: 'A', onList: vi.fn() }),
        React.createElement(TradeAssetColumn, { title: 'Give', subtitle: 'A', side: 'give', twoColumn: false, roster: [], picks: [pick], avgMap: new Map(), avgStatsMap: new Map(), selectedPlayerIds: new Set<string>(), selectedPickIds: new Set<string>(), onTogglePlayer: vi.fn(), onTogglePick: vi.fn(), emptyText: 'None' }),
    )) })
    expect(text().match(/2027 Round 1/g)).toHaveLength(4)
    expect(text()).not.toContain('2028')
    expect(screen.root.findAll(node => node.props?.accessibilityLabel === 'List 2027 Round 1 pick on trade block')).toHaveLength(1)
    expect(screen.root.findAll(node => /2027 Round 1 pick via A for trade/.test(node.props?.accessibilityLabel ?? ''))).toHaveLength(1)
})

it('shows every currently owned pick in Mine and excludes traded-away picks', async () => {
    const retained = { ...pick, id: 'retained' }
    const received = { ...pick, id: 'received', originalOwnerMemberId: 'b', originalTeamName: 'B' }
    const sent = { ...pick, id: 'sent', currentOwnerMemberId: 'b', currentTeamName: 'B' }
    await act(async () => { screen = create(React.createElement(PicksBankList, { picks: [retained, received, sent], myMemberId: 'a' })) })
    const rows = () => screen.root.findAll(node => node.props.role === 'listitem')
    expect(rows()).toHaveLength(2)
    expect(rows().map(row => row.props.accessibilityLabel)).toEqual([
        '2027 Round 1, from A, owner You, original pick',
        '2027 Round 1, from B, owner You, traded pick',
    ])
    const filters = screen.root.findByType('SegmentedControl' as React.ElementType)
    expect(filters.props.options.map((option: { badge: number }) => option.badge)).toEqual([2, 3, 2])
    await act(async () => filters.props.onChange('traded'))
    expect(rows()).toHaveLength(2)
    await act(async () => filters.props.onChange('all'))
    expect(rows()).toHaveLength(3)
})

it('keeps an honest Mine empty state when all original picks were traded away', async () => {
    await act(async () => { screen = create(React.createElement(PicksBankList, { picks: [{ ...pick, currentOwnerMemberId: 'b' }], myMemberId: 'a' })) })
    expect(screen.root.findAll(node => node.props.role === 'listitem')).toHaveLength(0)
    expect(screen.root.findByType('EmptyState' as React.ElementType).props.message).toBe('No picks assigned to you yet.')
})
