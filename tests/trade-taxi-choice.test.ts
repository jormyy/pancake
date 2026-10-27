import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { trade } from './helpers/fixtures'
import type { RoutedTradeItem } from '@/lib/trades'

const league = vi.hoisted(() => ({ id: 'league-a', taxi_slots: 3, allow_inactive_trades: false }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: league }) }))
vi.mock('@/components/TaxiAcquisitionChoice', () => ({ TaxiAcquisitionChoice: 'TaxiAcquisitionChoice' }))
vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: 'PendingTradeRosterPlan' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/components/trades/TradeCard', () => ({
    AssetList: () => null, StatusChip: () => null, TradeActionButtons: () => null,
    tradeFlowItem: () => null,
    tradeCardModel: () => ({ opponentName: 'Team B', meta: [], receives: [], gives: [] }),
}))

const incoming = { kind: 'player', playerId: 'incoming', playerName: 'Incoming', position: 'PG', nbaTeam: 'BOS', fromMemberId: 'member-b', toMemberId: 'member-a' } as const
const actions = { acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onTaxiDestination: vi.fn(), onRosterPlan: vi.fn() }

describe('trade roster destination', () => {
    it.each([false, true])('uses one full plan editor when inactive trades are %s', async (allowInactive) => {
        league.allow_inactive_trades = allowInactive
        const item: RoutedTradeItem = { ...incoming, yearsExp: 0, nbaDraftNumber: 12 }
        const value = trade({ status: 'pending', routedItems: [item] })
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(TradeDetailsPanel, {
            context: { trade: value, myMemberId: 'member-a', tab: 'offers' }, actions, onAnalyze: vi.fn(),
        })) })
        expect(renderer.root.findAllByType('TaxiAcquisitionChoice' as React.ElementType)).toHaveLength(0)
        const editors = renderer.root.findAllByType('PendingTradeRosterPlan' as React.ElementType)
        expect(editors).toHaveLength(1)
        expect(editors[0].props.onChange).toBe(actions.onRosterPlan)
        expect(editors[0].props.memberId).toBe('member-a')
        await act(async () => renderer.unmount())
    })

    it('does not expose destination controls after acceptance', async () => {
        const value = trade({ status: 'accepted', routedItems: [{ ...incoming, yearsExp: 0 }] })
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(TradeDetailsPanel, {
            context: { trade: value, myMemberId: 'member-a', tab: 'offers' }, actions, onAnalyze: vi.fn(),
        })) })
        expect(renderer.root.findAllByType('TaxiAcquisitionChoice' as React.ElementType)).toHaveLength(0)
        expect(renderer.root.findAllByType('PendingTradeRosterPlan' as React.ElementType)).toHaveLength(0)
        await act(async () => renderer.unmount())
    })
})
