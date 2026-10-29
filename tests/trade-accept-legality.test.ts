import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { trade, rosterPlayer } from './helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

const mocks = vi.hoisted(() => ({ read: vi.fn(), roster: vi.fn(), accept: vi.fn(), withdraw: vi.fn(), confirm: vi.fn() }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('@/components/ui', () => ({ Button: 'Button', ErrorBanner: 'ErrorBanner', PageHeader: ({ title, actions }: { title: string; actions: React.ReactNode }) => React.createElement('View', null, title, actions) }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.roster }))
vi.mock('@/lib/trade-legality', () => ({ previewTradeLegality: mocks.read }))
vi.mock('@/lib/trades', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/trades')>(), acceptTrade: mocks.accept, withdrawTrade: mocks.withdraw }))
vi.mock('@/lib/alert', () => ({ confirmAction: mocks.confirm }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league', ir_slots: 2, taxi_slots: 3 } }) }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

it.each(['member-a', 'member-b'])('allows only the proposer to cancel during review: %s', async memberId => {
    mocks.withdraw.mockClear()
    mocks.withdraw.mockResolvedValue(undefined)
    mocks.confirm.mockImplementation((_title, _message, confirm) => confirm())
    const offer = trade({ status: 'accepted', vetoWindowExpiresAt: new Date(Date.now() + 3600000).toISOString() })
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeDetailsPanel, {
        context: { trade: offer, myMemberId: memberId, tab: 'history' },
        actions: { acting: true, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn() }, onAnalyze: vi.fn(),
    })) })
    const buttons = view.root.findAllByProps({ title: 'Cancel trade' })
    expect(buttons).toHaveLength(memberId === 'member-a' ? 1 : 0)
    if (buttons.length) {
        expect(buttons[0].props.disabled).toBe(false)
        await act(async () => buttons[0].props.onPress())
        expect(mocks.withdraw).toHaveBeenCalledWith(offer.id, memberId)
        expect(JSON.stringify(view.toJSON())).toContain('Trade cancelled. Saved roster choices did not run.')
    }
    await act(async () => view.unmount())
})

it('shows the SQL cancellation error and retains the trade', async () => {
    mocks.withdraw.mockRejectedValue(new Error('The review window has ended.'))
    mocks.confirm.mockImplementation((_title, _message, confirm) => confirm())
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeDetailsPanel, {
        context: { trade: trade({ status: 'accepted', vetoWindowExpiresAt: new Date(Date.now() + 3600000).toISOString() }), myMemberId: 'member-a', tab: 'history' },
        actions: { acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn() }, onAnalyze: vi.fn(),
    })) })
    await act(async () => view.root.findByProps({ title: 'Cancel trade' }).props.onPress())
    expect(JSON.stringify(view.toJSON())).toContain('The review window has ended.')
    expect(view.root.findByProps({ title: 'Cancel trade' }).props.disabled).toBe(false)
    await act(async () => view.unmount())
})

it('opens a roster preview and saves the repaired plan with acceptance', async () => {
    const errors = vi.spyOn(console, 'error')
    const preview: TradeRosterPreview = {
        memberId: 'member-b', teamName: 'Team B', limits: { active: 0, ir: 2, taxi: 3 },
        roster: [{ playerId: 'player-a', name: 'Player A', location: 'active' }], drops: [], moves: [], legal: false, error: 'overflow',
        reasons: [{ memberId: 'member-b', teamName: 'Team B', rule: 'active_slots', message: 'Team B must drop 1 player.', suggestedMoves: [] }],
    }
    mocks.roster.mockResolvedValue([rosterPlayer()])
    mocks.read.mockResolvedValue([preview])
    mocks.accept.mockResolvedValue(undefined)
    const onRosterPlan = vi.fn()
    const offer = trade({ status: 'pending', completedAt: null })
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeDetailsPanel, {
        context: { trade: offer, myMemberId: 'member-b', tab: 'offers' },
        actions: { acting: false, onAccept: vi.fn(), onRosterPlan, onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn() }, onAnalyze: vi.fn(),
    })) })
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Accept trade with Team A' }).props.onPress())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
    const duplicateKeys = errors.mock.calls.some(call => call.map(String).join(' ').includes('same key'))
    errors.mockRestore()
    expect(duplicateKeys).toBe(false)
    expect(JSON.stringify(view.toJSON())).toContain('Make it legal')
    expect(JSON.stringify(view.toJSON())).toContain('Team B must drop 1 player.')
    const confirm = () => view.root.findByProps({ title: 'Confirm' })
    expect(confirm().props.disabled).toBe(true)
    mocks.read.mockResolvedValue([{ ...preview, roster: [], error: null, reasons: [], legal: true }])
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Drop Player A at completion' }).props.onPress())
    expect(onRosterPlan).not.toHaveBeenCalled()
    expect(mocks.accept).not.toHaveBeenCalled()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
    expect(confirm().props.disabled).toBe(false)
    await act(async () => confirm().props.onPress())
    expect(mocks.accept).toHaveBeenCalledWith(offer.id, 'member-b', {
        taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: ['player-a'], rosterMoves: [],
    })
    expect(JSON.stringify(view.toJSON())).toContain('Waiting for review and execution.')
    await act(async () => view.unmount())
})
