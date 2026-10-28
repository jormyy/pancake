import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeDetailsPanel } from '@/components/trades/TradeDetailsPanel'
import { trade, rosterPlayer } from './helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

const mocks = vi.hoisted(() => ({ read: vi.fn(), roster: vi.fn() }))
vi.mock('@/lib/roster', () => ({ getRoster: mocks.roster }))
vi.mock('@/lib/trades', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/trades')>(), getTradeRosterPreview: mocks.read }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league', ir_slots: 2, taxi_slots: 3 } }) }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

it('keeps Accept disabled while loading or illegal and enables it after the saved drop makes both teams legal', async () => {
    const preview: TradeRosterPreview = {
        memberId: 'member-b', teamName: 'Team B', limits: { active: 0, ir: 2, taxi: 3 },
        roster: [{ playerId: 'player-a', name: 'Player A', location: 'active' }], drops: [], moves: [], error: 'overflow',
    }
    mocks.roster.mockResolvedValue([rosterPlayer()])
    let resolve!: (value: unknown) => void
    mocks.read.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const onAccept = vi.fn(), onRosterPlan = vi.fn()
    const offer = trade({ status: 'pending', completedAt: null })
    const actions = { acting: false, onAccept, onRosterPlan, onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn() }
    const render = (value = offer) => React.createElement(TradeDetailsPanel, {
        context: { trade: value, myMemberId: 'member-b', tab: 'offers' }, actions, onAnalyze: vi.fn(),
    })
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(render()) })
    const accept = () => view.root.findByProps({ accessibilityLabel: 'Accept trade with Team A' })
    expect(accept().props.disabled).toBe(true)
    await act(async () => resolve([preview]))
    expect(accept().props.disabled).toBe(true)
    expect(JSON.stringify(view.toJSON())).toContain('Drop 1 player to continue')
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Drop Player A at completion' }).props.onPress())
    expect(onRosterPlan).toHaveBeenCalledWith({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: ['player-a'], rosterMoves: [] })
    expect(accept().props.disabled).toBe(true)
    mocks.read.mockResolvedValueOnce([{ ...preview, roster: [], drops: [{ playerId: 'player-a', name: 'Player A' }], error: null }])
    await act(async () => view.update(render({ ...offer, participants: [{ memberId: 'member-b', teamName: 'Team B', acceptedAt: null, isInitiator: false, sortOrder: 1, dropPlayerIds: ['player-a'], rosterMoves: [] }] })))
    expect(accept().props.disabled).toBe(false)
    await act(async () => accept().props.onPress())
    expect(onAccept).toHaveBeenCalledOnce()
    await act(async () => view.unmount())
})
