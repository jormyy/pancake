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
    memberId: 'me', teamName: 'My team', limits: { active: 0, ir: 0, taxi: 0 },
    roster: [{ playerId: 'player-a', name: 'Player A', location: 'active' }],
    drops: [], moves: [], error: 'This team needs a plan for its regular roster limit.',
}

it('uses capacity lines without repeated explanations', async () => {
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPreviewList, { teams: [team] })) })
    expect(JSON.stringify(view.toJSON())).toContain('My team: 1/0 · IR 0/0 · Taxi 0/0')
    expect(JSON.stringify(view.toJSON())).not.toContain('must drop')
    expect(JSON.stringify(view.toJSON())).not.toContain('needs a plan')
    await act(async () => view.unmount())
})

it('shows one compact picker without disclosures or explanatory sentences', async () => {
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPlanEditor, {
        incoming: [], roster: [rosterPlayer()], value: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }, onChange: vi.fn(),
    })) })
    expect(view.root.findAllByProps({ accessibilityLabel: 'Drop Player A at completion' })).toHaveLength(1)
    expect(JSON.stringify(view.toJSON())).not.toContain('Choose drops')
    expect(JSON.stringify(view.toJSON())).not.toContain('requires')
    await act(async () => view.unmount())
})

it.each([
    [{ active: 0, ir: 0, taxi: 0 }, ['active', 'active'], 'Drop 2 players to continue'],
    [{ active: 0, ir: 1, taxi: 0 }, ['active'], 'Move 1 player to IR or drop 1'],
    [{ active: 1, ir: 0, taxi: 0 }, ['taxi'], 'Move 1 player to Regular or drop 1'],
    [{ active: 0, ir: 0, taxi: 0 }, ['taxi'], 'Drop 1 player to continue'],
    [{ active: 0, ir: 0, taxi: 0 }, ['ir'], 'Drop 1 player to continue'],
    [{ active: 1, ir: 0, taxi: 0 }, ['ir'], 'Move 1 player to Regular or drop 1'],
] as const)('describes the one legality step for %j and %j', (limits, locations, text) => {
    const roster = [rosterPlayer()]
    roster[0].players.injury_status = 'Out'
    const preview = { ...team, limits, roster: locations.map((location, index) => ({ playerId: index ? 'second' : 'player-a', name: 'Player', location })) }
    expect(tradeLegalityStep(preview, roster, [])).toBe(text)
    expect(isTradeRosterLegal(preview)).toBe(false)
})

it('does not promise IR when it lacks enough space or eligible players', () => {
    const preview = { ...team, limits: { active: 0, ir: 2, taxi: 0 } }
    expect(tradeLegalityStep(preview, [rosterPlayer()], [])).toBe('Drop 1 player to continue')
})

it('shows the legality step above the picker and removes the drop when choosing a move', async () => {
    const onChange = vi.fn()
    const player = rosterPlayer()
    player.players.injury_status = 'Out'
    let view!: ReturnType<typeof create>
    await act(async () => { view = create(React.createElement(TradeRosterPlanEditor, {
        incoming: [], roster: [player], value: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: ['player-a'] }, onChange,
        preview: { ...team, limits: { active: 0, ir: 1, taxi: 0 } },
    })) })
    expect(JSON.stringify(view.toJSON())).toContain('Move 1 player to IR or drop 1')
    await act(async () => view.root.findByProps({ accessibilityLabel: 'Player A: ir' }).props.onPress())
    expect(onChange).toHaveBeenCalledWith({ taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [], rosterMoves: [{ playerId: 'player-a', destination: 'ir' }] })
    await act(async () => view.unmount())
})
