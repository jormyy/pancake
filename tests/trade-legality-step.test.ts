import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeRosterPlanEditor } from '@/components/trades/TradeRosterPlanEditor'
import { tradeRosterReasons } from '@/lib/trade-roster-status'
import { isTradeRosterLegal } from '@/lib/trade-legality-step'
import { rosterPlayer } from './helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

const team: TradeRosterPreview = {
    memberId: 'me', teamName: 'Justin', limits: { active: 0, ir: 0, taxi: 0 },
    roster: [{ playerId: 'player-a', name: 'Player A', location: 'active' }],
    drops: [], moves: [], legal: false, error: 'IR blocks this trade.',
    reasons: [{ memberId: 'me', teamName: 'Justin', rule: 'ir_eligibility', playerId: 'player-a', message: 'Justin: Player A cannot use IR.',
        suggestedMoves: [{ action: 'move', playerId: 'player-a', destination: 'active', message: 'Move Player A to Regular.' }] }],
}

it('shortens a structured eligibility reason without repeating suggestions', () => {
    expect(tradeRosterReasons(team)).toEqual(["Player A isn't IR-eligible"])
})

it('uses the SQL verdict even when local counts disagree', () => {
    expect(isTradeRosterLegal({ ...team, legal: true, error: null, reasons: [] })).toBe(true)
    expect(isTradeRosterLegal(team)).toBe(false)
})

it('uses SQL eligibility and preserves drops while choosing an IR move', async () => {
    const onChange = vi.fn()
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPlanEditor, {
        incoming: [], roster: [rosterPlayer({ players: { ...rosterPlayer().players, injury_status: 'Out' } })], value: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: ['player-a'] }, onChange,
        preview: team, unavailableDestinations: { 'player-a': { taxi: 'Only incoming players can enter taxi.' } },
    })) })
    expect(view.root.findByProps({ accessibilityLabel: 'Player A: taxi' }).props.disabled).toBe(true)
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Player A: ir' }).props.onPress())
    expect(onChange).toHaveBeenCalledWith({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [], rosterMoves: [{ playerId: 'player-a', destination: 'ir' }] })
    await act(async () => view.unmount())
})
