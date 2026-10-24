import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { trade } from './helpers/fixtures'
import type { TradeItem } from '@/lib/trades'

vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { taxi_slots: 3, taxi_rule: 'drafted_rookies' } }) }))
vi.mock('@/components/TaxiAcquisitionChoice', () => ({ TaxiAcquisitionChoice: 'TaxiAcquisitionChoice' }))
vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/components/trades/TradeCard', () => ({
    AssetList: () => null, StatusChip: () => null, TradeActionButtons: () => null,
    tradeFlowItem: () => null,
    tradeCardModel: () => ({ opponentName: 'Team B', meta: [], receives: [], gives: [] }),
}))

const incoming = { kind: 'player', playerId: 'incoming', playerName: 'Incoming', position: 'PG', nbaTeam: 'BOS', fromMemberId: 'member-b', toMemberId: 'member-a' } as const
const actions = { acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onTaxiDestination: vi.fn() }

describe('trade taxi destination', () => {
    it.each([
        ['veteran', { yearsExp: 4, nbaDraftNumber: 12 }, 0],
        ['drafted rookie', { yearsExp: 0, nbaDraftNumber: 12 }, 1],
        ['undrafted rookie', { yearsExp: 0, nbaDraftNumber: null }, 0],
        ['existing placement', { yearsExp: 4, nbaDraftNumber: 12, toTaxi: true }, 1],
    ] as const)('only offers a usable or removable taxi choice for %s', async (_name, fields, count) => {
        const item: TradeItem = { ...incoming, ...fields }
        const value = trade({ status: 'pending', routedItems: [{ ...item, fromMemberId: 'member-b', toMemberId: 'member-a' }] })
        let renderer!: ReturnType<typeof create>
        await act(async () => { renderer = create(React.createElement(TradeDetailsPanel, {
            context: { trade: value, myMemberId: 'member-a', tab: 'offers' }, actions, onAnalyze: vi.fn(),
        })) })
        expect(renderer.root.findAllByType('TaxiAcquisitionChoice' as React.ElementType)).toHaveLength(count)
        await act(async () => renderer.unmount())
    })
})
