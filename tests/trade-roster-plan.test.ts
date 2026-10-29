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
    it('explains SQL rejection of incoming IR and taxi destinations', async () => {
        const unavailableDestinations = { incoming: {
            ir: 'IR requires an Out or IR designation.',
            taxi: 'Taxi requires a rookie or fewer than 65 known career games.',
        } }
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [], value: emptyPlan, onChange: vi.fn(), unavailableDestinations,
        })) })
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: ir' }).props.disabled).toBe(true)
        expect(renderer!.root.findByProps({ accessibilityLabel: 'Incoming player: taxi' }).props.disabled).toBe(true)
        expect(JSON.stringify(renderer!.toJSON())).toContain(unavailableDestinations.incoming.ir)
        expect(JSON.stringify(renderer!.toJSON())).toContain(unavailableDestinations.incoming.taxi)
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
        expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Incoming player: active' })).toHaveLength(0)
        expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Incoming player: ir' })).toHaveLength(0)
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
