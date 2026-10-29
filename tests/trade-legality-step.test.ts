import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeRosterPlanEditor } from '@/components/trades/TradeRosterPlanEditor'
import { TradeRosterPreviewList } from '@/components/trades/TradeRosterPreviewList'
import { tradeLegalityStep, isTradeRosterLegal } from '@/lib/trade-legality-step'
import { rosterPlayer } from './helpers/fixtures'
import type { TradeRosterPreview } from '@/lib/trades'

const team: TradeRosterPreview = {
    memberId: 'me', teamName: 'Justin', limits: { active: 0, ir: 0, taxi: 0 },
    roster: [{ playerId: 'player-a', name: 'Player A', location: 'active' }],
    drops: [], moves: [], legal: false, error: 'IR blocks this trade.',
    reasons: [{ memberId: 'me', teamName: 'Justin', rule: 'ir_eligibility', message: 'Justin: Player A cannot use IR.',
        suggestedMoves: [{ action: 'move', playerId: 'player-a', destination: 'active', message: 'Move Player A to Regular.' }] }],
}

it('shows the SQL team, rule explanation, and concrete fix', async () => {
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPreviewList, { teams: [team] })) })
    const text = JSON.stringify(view.toJSON())
    expect(text).toContain('Justin: Player A cannot use IR.')
    expect(text).toContain('Move Player A to Regular.')
    await act(async () => view.unmount())
})

it('uses the SQL verdict even when local counts disagree', () => {
    expect(isTradeRosterLegal({ ...team, legal: true, error: null, reasons: [] })).toBe(true)
    expect(isTradeRosterLegal(team)).toBe(false)
    expect(tradeLegalityStep(team, [], [])).toBe('Make this roster legal')
})

it('uses SQL eligibility and preserves drops while choosing a taxi move', async () => {
    const onChange = vi.fn()
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPlanEditor, {
        incoming: [], roster: [rosterPlayer()], value: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: ['player-a'] }, onChange,
        preview: team, unavailableDestinations: { 'player-a': { ir: 'IR requires Out or IR.' } },
    })) })
    expect(view.root.findByProps({ accessibilityLabel: 'Player A: ir' }).props.disabled).toBe(true)
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Player A: taxi' }).props.onPress())
    expect(onChange).toHaveBeenCalledWith({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [], rosterMoves: [{ playerId: 'player-a', destination: 'taxi' }] })
    await act(async () => view.unmount())
})
