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
    it('keeps late drop choices behind a manager-controlled disclosure', async () => {
        const onChange = vi.fn()
        const render = (roster: ReturnType<typeof rosterPlayer>[]) => React.createElement(TradeRosterPlanEditor, {
            incoming, roster, value: emptyPlan, onChange,
        })
        await act(async () => { renderer = create(render([])) })
        const before = JSON.stringify(renderer!.toJSON())
        await act(async () => { renderer!.update(render([rosterPlayer()])) })
        expect(JSON.stringify(renderer!.toJSON())).toEqual(before)
        const toggle = renderer!.root.findByProps({ accessibilityLabel: 'Choose drops at trade completion' })
        expect(toggle.props.accessibilityState.expanded).toBe(false)
        await act(async () => toggle.props.onPress())
        expect(renderer!.root.findAllByProps({ children: 'Drops happen at completion. They will stay on waivers until the first 3 AM ET run after 48 hours.' })).toHaveLength(1)
        const drop = renderer!.root.findByProps({ accessibilityLabel: 'Drop Player A at completion' })
        await act(async () => drop.props.onPress())
        expect(onChange).toHaveBeenCalledWith({ ...emptyPlan, dropPlayerIds: ['player-a'] })
    })

    it('keeps existing drops visible and preserves them when changing placement', async () => {
        const onChange = vi.fn()
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming, roster: [rosterPlayer()], value: { ...emptyPlan, dropPlayerIds: ['player-a'] }, onChange,
        })) })
        const toggle = renderer!.root.findByProps({ accessibilityLabel: 'Choose drops at trade completion' })
        expect(toggle.findAllByProps({ children: '1 drop' })).toHaveLength(1)
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
        expect(renderer!.root.findAllByProps({ children: 'Taxi · tenure retained' })).toHaveLength(1)
        expect(onChange).not.toHaveBeenCalled()
    })

    it('hides placements when the league has no matching slots', async () => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], yearsExp: 0, nbaDraftNumber: 1 }],
            roster: [], value: emptyPlan, onChange: vi.fn(), allowIR: false, allowTaxi: false,
        })) })
        expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Incoming player: ir' })).toHaveLength(0)
        expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Incoming player: taxi' })).toHaveLength(0)
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

    it('shows a fixed active destination without a one-option picker', async () => {
        await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
            incoming: [{ ...incoming[0], injuryStatus: null }], roster: [], value: emptyPlan, onChange: vi.fn(),
        })) })
        expect(renderer!.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(0)
        expect(renderer!.root.findAllByProps({ children: 'Active' })).toHaveLength(1)
    })

})
