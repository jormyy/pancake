import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tradeDraft } from '@/lib/trade-draft'
import { createMultiTeamTradeState, multiTeamTradeReducer, buildMultiTeamTradeItems } from '@/lib/multi-team-trade-state'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
import { RosterPlayerRow } from '@/components/roster/RosterItems'
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

it('orders draft incoming players by value and stable keys without reordering existing roster rows', async () => {
    let state = createMultiTeamTradeState('me')
    state = multiTeamTradeReducer(state, { type: 'set-participants', actorMemberId: 'me', participantIds: ['me', 'them'] })
    const players = [
        { id: 'missing-z', name: 'Z missing', value: null },
        { id: 'low', name: 'Low', value: 100 },
        { id: 'tie-z', name: 'Tie', value: 800 },
        { id: 'high', name: 'High', value: 900 },
        { id: 'missing-a', name: 'A missing', value: null },
        { id: 'tie-a', name: 'Tie', value: 800 },
        { id: 'alpha', name: 'Alpha', value: 800 },
    ]
    for (const player of players) state = multiTeamTradeReducer(state, { type: 'select-asset', memberId: 'them', asset: 'player', assetId: player.id })
    const roster = players.map(player => {
        const row = rosterPlayer()
        return { ...row, tradeValue: player.value, players: { ...row.players, id: player.id, display_name: player.name } }
    })
    const participants: TradeParticipantView[] = ['me', 'them'].map(memberId => ({
        memberId, roster: memberId === 'them' ? roster : [], picks: [], destinationIds: [memberId === 'me' ? 'them' : 'me'],
        defaultDestinationId: memberId === 'me' ? 'them' : 'me', selectedPlayerIds: new Set(memberId === 'them' ? players.map(player => player.id) : []),
        selectedPickIds: new Set(), playerDestinationIds: {}, pickDestinationIds: {}, faabInputs: {},
    }))
    const draft = tradeDraft({ items: buildMultiTeamTradeItems(state, false), participants, memberId: 'me', participantName: id => id,
        notes: '', expiresAt: null, avgMap: new Map(), avgStatsMap: new Map() })
    const incoming = draft.routedItems.filter(item => item.toMemberId === 'me')
    const existing = [rosterPlayer(), rosterPlayer()]
    existing[0].players = { ...existing[0].players, id: 'existing-z', display_name: 'Z existing' }
    existing[1].players = { ...existing[1].players, id: 'existing-a', display_name: 'A existing' }
    await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
        incoming, roster: existing, value: emptyPlan, onChange: vi.fn(),
    })) })
    const rows = renderer!.root.findAllByType(RosterPlayerRow).map(row => row.props.item.players.id)
    expect(rows).toEqual(['existing-z', 'existing-a', 'high', 'alpha', 'tie-a', 'tie-z', 'low', 'missing-a', 'missing-z'])
    expect(incoming.map(item => item.kind === 'player' ? item.playerId : '')).toEqual(players.map(player => player.id))
    expect(existing.map(row => row.players.id)).toEqual(['existing-z', 'existing-a'])
})

it('keeps lock explanations and roster choices outside the player stats target', async () => {
    const player = rosterPlayer({ assetLocks: [{ assetKind: 'player', assetId: 'player-a', sourceKind: 'trade', sourceId: 'offer', reason: 'Pending trade' }] })
    await act(async () => { renderer = create(React.createElement(TradeRosterPlanEditor, {
        incoming: [], roster: [player], value: emptyPlan, onChange: vi.fn(), unavailableMoves: { 'player-a': 'Pending trade' },
    })) })
    const targets = renderer!.root.findAllByType('Pressable' as React.ElementType)
    expect(targets.some(target => target.props.accessibilityLabel === 'Locked by a pending trade')).toBe(true)
    for (const target of targets) expect(target.findAllByType('Pressable' as React.ElementType)).toHaveLength(1)
    expect(targets.find(target => target.props.accessibilityLabel === 'Open Player A')?.props.onPress).toBeTypeOf('function')
})
