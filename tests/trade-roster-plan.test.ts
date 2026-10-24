import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TradeRosterPlanEditor } from '@/components/trades/TradeRosterPlanEditor'
import { rosterPlayer } from './helpers/fixtures'
import type { TradeItem, TradeRosterPlan } from '@/lib/trades'

const incoming: TradeItem[] = [{ kind: 'player', playerId: 'incoming', playerName: 'Incoming player', position: 'PG', nbaTeam: 'BOS', injuryStatus: 'Out' }]
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
})
