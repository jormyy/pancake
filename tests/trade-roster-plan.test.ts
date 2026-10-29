import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TradeRosterPlanEditor } from '@/components/trades/TradeRosterPlanEditor'
import { rosterPlayer } from './helpers/fixtures'
import type { TradeItem, TradeRosterPlan } from '@/lib/trades'

const incoming: Extract<TradeItem, { kind: 'player' }>[] = [{ kind: 'player', playerId: 'incoming', playerName: 'Incoming player', position: 'PG', nbaTeam: 'BOS', injuryStatus: 'Out' }]
const emptyPlan: TradeRosterPlan = { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = null
})

describe('trade roster plan', () => {
    it('disables ineligible destinations without repeating rule sentences', async () => {
        const unavailableDestinations = { incoming: {
            ir: 'IR requires an Out or IR designation.',
            taxi: 'Taxi requires a rookie or fewer than 65 known career games.',
        } }
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [], value: emptyPlan, onChange: vi.fn(), unavailableDestinations,
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.disabled).toBe(true)
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(unavailableDestinations.incoming.ir)
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(unavailableDestinations.incoming.taxi)
    })

    it('disables Taxi for an existing rookie even when the preview allows it', async () => {
        const onChange = vi.fn()
        const existing = rosterPlayer()
        existing.players = { ...existing.players, years_exp: 0, career_regular_season_games: 0 }
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [], roster: [existing], value: emptyPlan, onChange,
        })) })
        const taxi = renderer!.root.findByProps({ accessibilityLabel: 'Player A: taxi' })
        expect(taxi.props.disabled).toBe(true)
        expect(taxi.props.style).toContainEqual({ opacity: 0.5 })
        await act(async () => taxi.props.onPress())
        expect(onChange).not.toHaveBeenCalled()
    })

    it.each([
        [0, null, false],
        [3, 64, false],
        [3, 65, true],
        [3, null, true],
    ])('uses shared Taxi eligibility for incoming players: experience %s, games %s', async (yearsExp, careerGames, disabled) => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], yearsExp, careerGames }], roster: [], value: emptyPlan, onChange: vi.fn(),
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.disabled).toBe(disabled)
    })

    it.each([['Out', false], ['IR', false], ['DTD', true], [null, true]])('uses shared IR eligibility for %s', async (injuryStatus, disabled) => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], injuryStatus }], roster: [], value: emptyPlan, onChange: vi.fn(),
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(disabled)
    })

    it('uses roster averages and incoming trade statistics', async () => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], avgFantasyPoints: 27, avgMinutesPlayed: 25.1 }], roster: [rosterPlayer()],
            value: emptyPlan, onChange: vi.fn(), avgMap: new Map([['player-a', 42]]),
            avgStatsMap: new Map([['player-a', { avg_minutes_played: 31.5 }]]),
        })) })
        const text = JSON.stringify(renderer!.toJSON())
        for (const value of ['42.0', '31.5', '27.0', '25.1']) expect(text).toContain(value)
    })

    it('shows drop choices directly and saves the selected drop', async () => {
        const onChange = vi.fn()
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [rosterPlayer()], value: emptyPlan, onChange,
        })) })
        await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Drop Player A at completion' }).props.onPress())
        expect(onChange).toHaveBeenCalledWith({ ...emptyPlan, dropPlayerIds: ['player-a'], rosterMoves: [] })
        expect(JSON.stringify(renderer!.toJSON())).not.toContain('requires')
    })

    it('keeps existing drops visible and preserves them when changing placement', async () => {
        const onChange = vi.fn()
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [rosterPlayer()], value: { ...emptyPlan, dropPlayerIds: ['player-a'] }, onChange,
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Drop Player A at completion' }).props.accessibilityState.checked).toBe(true)
        await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.onPress())
        expect(onChange).toHaveBeenCalledWith({ taxiPlayerIds: [], irPlayerIds: ['incoming'], dropPlayerIds: ['player-a'] })
    })

    it('keeps an incoming taxi player on taxi without unusable placement controls', async () => {
        const onChange = vi.fn()
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], fromTaxi: true, yearsExp: 0, nbaDraftNumber: 1 }],
            roster: [], value: emptyPlan, onChange,
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: active' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.accessibilityState.checked).toBe(true)
        expect(onChange).not.toHaveBeenCalled()
    })

    it('disables placements without available slots', async () => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], yearsExp: 0, nbaDraftNumber: 1 }],
            roster: [], value: emptyPlan, onChange: vi.fn(), allowIR: false, allowTaxi: false,
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.disabled).toBe(true)
    })

    it('does not save an unchanged placement', async () => {
        const onChange = vi.fn()
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [], value: emptyPlan, onChange,
        })) })
        await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: active' }).props.onPress())
        expect(onChange).not.toHaveBeenCalled()
    })

    it('allows an eligible active rookie to enter and leave taxi', async () => {
        const onChange = vi.fn()
        const props = { incoming: [{ ...incoming[0], yearsExp: 0, nbaDraftNumber: 1 }], roster: [], value: emptyPlan, onChange }
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, props)) })
        await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.onPress())
        expect(onChange).toHaveBeenLastCalledWith({ ...emptyPlan, taxiPlayerIds: ['incoming'] })
        const taxiPlan = { ...emptyPlan, taxiPlayerIds: ['incoming'] }
        await act(async () => { renderer!.update(React.createElement(TradeRosterPlanEditor, { ...props, value: taxiPlan })) })
        await act(async () => renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: active' }).props.onPress())
        expect(onChange).toHaveBeenLastCalledWith(emptyPlan)
    })

    it('disables inactive slots for an ineligible player', async () => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], injuryStatus: null }], roster: [], value: emptyPlan, onChange: vi.fn(),
            unavailableDestinations: { incoming: { ir: 'IR requires Out.', taxi: 'Taxi requires eligibility.' } },
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: active' }).props.disabled).toBe(false)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: active' }).props.accessibilityState.checked).toBe(true)
    })

})
