import { describe, expect, it } from 'vitest'
import {
    buildMultiTeamTradeItems,
    createMultiTeamTradeState,
    canUpdateTradeFaabInput,
    isMultiTeamTradeSubmittable,
    MAX_TRADE_FAAB_DIGITS,
    multiTeamTradeReducer,
    multiTeamTradeStateFromTrade,
    validateTradeFaabInput,
} from '@/lib/multi-team-trade-state'
import type { RoutedTradeItem, Trade } from '@/lib/trades'
import { MAX_TRADE_FAAB_AMOUNT, MAX_TRADE_ITEMS, MAX_TRADE_PARTICIPANTS } from '@pancake/core'

const members = ['B', 'C']

function addParticipant(state: ReturnType<typeof createMultiTeamTradeState>, memberId: string) {
    return multiTeamTradeReducer(state, {
        type: 'toggle-participant',
        memberId,
        actorMemberId: 'A',
        availableMemberIds: members,
    })
}

function routedTrade(items: RoutedTradeItem[], participantIds = ['A', 'B', 'C']): Trade {
    return {
        id: 'trade',
        status: 'pending',
        proposedAt: '2026-01-01T00:00:00Z',
        acceptedAt: null,
        vetoWindowExpiresAt: null,
        completedAt: null,
        vetoedAt: null,
        expiresAt: null,
        notes: null,
        proposerMemberId: 'A',
        proposerTeamName: 'A Team',
        recipientMemberId: 'B',
        recipientTeamName: 'B Team',
        isMultiTeam: true,
        participants: participantIds.map((memberId, sortOrder) => ({
            memberId,
            teamName: `${memberId} Team`,
            sortOrder,
            isInitiator: memberId === 'A',
            acceptedAt: null,
        })),
        parentTradeId: null,
        counteredFromTradeId: null,
        editedFromTradeId: null,
        replacedByTradeId: null,
        version: 1,
        proposerFaabAmount: 0,
        recipientFaabAmount: 0,
        myVetoed: false,
        routedItems: items,
    }
}

describe('multi-team trade state', () => {
    it('accepts 12 participants, prevents a 13th selection, and fails closed on oversized prefills', () => {
        const participantIds = Array.from({ length: MAX_TRADE_PARTICIPANTS + 1 }, (_, index) => `member-${index}`)
        const routedItems = participantIds.map((memberId, index) => ({
            kind: 'player' as const,
            fromMemberId: memberId,
            toMemberId: participantIds[(index + 1) % participantIds.length],
            playerId: `player-${index}`,
        }))
        expect(isMultiTeamTradeSubmittable(
            participantIds.slice(0, MAX_TRADE_PARTICIPANTS),
            routedItems.slice(0, MAX_TRADE_PARTICIPANTS - 1).concat({
                ...routedItems[MAX_TRADE_PARTICIPANTS - 1],
                toMemberId: participantIds[0],
            }),
        )).toBe(true)
        expect(isMultiTeamTradeSubmittable(participantIds, routedItems)).toBe(false)

        const legacyItems: RoutedTradeItem[] = routedItems.map((item, index) => ({
            kind: 'player',
            playerId: item.playerId,
            playerName: `Player ${index}`,
            position: 'PG',
            eligiblePositions: ['PG'],
            nbaTeam: null,
            nbaId: null,
            injuryStatus: null,
            yearsExp: 1,
            fromMemberId: item.fromMemberId,
            toMemberId: item.toMemberId,
        }))
        const prefilled = multiTeamTradeStateFromTrade(routedTrade(legacyItems, participantIds), participantIds[0])
        expect(prefilled.participantOrder).toHaveLength(MAX_TRADE_PARTICIPANTS + 1)
        expect(isMultiTeamTradeSubmittable(
            prefilled.participantOrder,
            buildMultiTeamTradeItems(prefilled, false),
        )).toBe(false)

        let state = multiTeamTradeReducer(createMultiTeamTradeState(participantIds[0]), {
            type: 'set-participants',
            actorMemberId: participantIds[0],
            participantIds: participantIds.slice(0, MAX_TRADE_PARTICIPANTS),
        })
        state = multiTeamTradeReducer(state, {
            type: 'toggle-participant',
            actorMemberId: participantIds[0],
            memberId: participantIds[MAX_TRADE_PARTICIPANTS],
            availableMemberIds: participantIds.slice(1),
        })
        expect(state.participantOrder).toHaveLength(MAX_TRADE_PARTICIPANTS)
    })

    it('accepts 100 items, rejects 101, and prevents the 101st composer selection', () => {
        const participantIds = ['A', 'B', 'C']
        const items = Array.from({ length: MAX_TRADE_ITEMS + 1 }, (_, index) => ({
            kind: 'player' as const,
            fromMemberId: participantIds[index % participantIds.length],
            toMemberId: participantIds[(index + 1) % participantIds.length],
            playerId: `player-${index}`,
        }))
        expect(isMultiTeamTradeSubmittable(participantIds, items.slice(0, MAX_TRADE_ITEMS))).toBe(true)
        expect(isMultiTeamTradeSubmittable(participantIds, items)).toBe(false)

        let state = multiTeamTradeReducer(createMultiTeamTradeState('A'), {
            type: 'set-participants',
            actorMemberId: 'A',
            participantIds,
        })
        for (let index = 0; index < MAX_TRADE_ITEMS + 1; index += 1) {
            state = multiTeamTradeReducer(state, {
                type: 'select-asset',
                asset: 'player',
                memberId: participantIds[index % participantIds.length],
                assetId: `player-${index}`,
            })
        }
        expect(buildMultiTeamTradeItems(state, false)).toHaveLength(MAX_TRADE_ITEMS)
        expect(buildMultiTeamTradeItems(state, false).some((item) =>
            item.kind === 'player' && item.playerId === `player-${MAX_TRADE_ITEMS}`)).toBe(false)
    })

    it('retains an oversized legacy prefill but fails it closed until items are removed', () => {
        const items = Array.from({ length: MAX_TRADE_ITEMS + 1 }, (_, index): RoutedTradeItem => ({
            kind: 'player',
            playerId: `player-${index}`,
            playerName: `Player ${index}`,
            position: 'PG',
            eligiblePositions: ['PG'],
            nbaTeam: null,
            nbaId: null,
            injuryStatus: null,
            yearsExp: 1,
            fromMemberId: ['A', 'B', 'C'][index % 3],
            toMemberId: ['B', 'C', 'A'][index % 3],
        }))
        const state = multiTeamTradeStateFromTrade(routedTrade(items), 'A')
        const rebuilt = buildMultiTeamTradeItems(state, false)

        expect(rebuilt).toHaveLength(MAX_TRADE_ITEMS + 1)
        expect(isMultiTeamTradeSubmittable(state.participantOrder, rebuilt)).toBe(false)
    })

    it('accepts maximum FAAB, prevents overflow, and lets oversized prefills be reduced', () => {
        const longPaste = '9'.repeat(100_000)
        expect(validateTradeFaabInput(longPaste)).toEqual({
            amount: MAX_TRADE_FAAB_AMOUNT + 1,
            error: 'FAAB amount cannot exceed 1,000,000.',
        })
        expect(canUpdateTradeFaabInput('0', longPaste)).toBe(false)
        expect(MAX_TRADE_FAAB_DIGITS).toBe(String(MAX_TRADE_FAAB_AMOUNT).length)

        const historicalPrefillSteps = [
            '2147483647',
            '214748364',
            '21474836',
            '2147483',
            '214748',
        ]
        for (let index = 1; index < historicalPrefillSteps.length; index += 1) {
            expect(canUpdateTradeFaabInput(
                historicalPrefillSteps[index - 1],
                historicalPrefillSteps[index],
            )).toBe(true)
        }
        expect(canUpdateTradeFaabInput('2147483647', '2147483647')).toBe(false)
        expect(canUpdateTradeFaabInput('2147483647', '3147483647')).toBe(false)
        expect(canUpdateTradeFaabInput('2147483647', longPaste)).toBe(false)
        expect(canUpdateTradeFaabInput('2147483647', String(MAX_TRADE_FAAB_AMOUNT))).toBe(true)

        let state = multiTeamTradeReducer(createMultiTeamTradeState('A'), {
            type: 'set-participants',
            actorMemberId: 'A',
            participantIds: ['A', 'B', 'C'],
        })
        state = multiTeamTradeReducer(state, {
            type: 'set-faab', memberId: 'A', toMemberId: 'B', value: String(MAX_TRADE_FAAB_AMOUNT),
        })
        expect(state.participants.A.faabInputs.B).toBe(String(MAX_TRADE_FAAB_AMOUNT))

        state = multiTeamTradeReducer(state, {
            type: 'set-faab', memberId: 'A', toMemberId: 'B', value: String(MAX_TRADE_FAAB_AMOUNT + 1),
        })
        expect(state.participants.A.faabInputs.B).toBe(String(MAX_TRADE_FAAB_AMOUNT))
        expect(canUpdateTradeFaabInput(
            String(MAX_TRADE_FAAB_AMOUNT),
            String(MAX_TRADE_FAAB_AMOUNT + 1),
        )).toBe(false)

        const prefilled = multiTeamTradeStateFromTrade(routedTrade([
            { kind: 'faab', amount: MAX_TRADE_FAAB_AMOUNT + 1, fromMemberId: 'A', toMemberId: 'B' },
            { kind: 'pick', pickId: 'pick-1', seasonYear: 2028, round: 1, originalTeamName: 'C Team', fromMemberId: 'C', toMemberId: 'A' },
        ]), 'A')
        const oversizedItems = buildMultiTeamTradeItems(prefilled, true)
        expect(validateTradeFaabInput(prefilled.participants.A.faabInputs.B).error)
            .toBe('FAAB amount cannot exceed 1,000,000.')
        expect(isMultiTeamTradeSubmittable(prefilled.participantOrder, oversizedItems)).toBe(false)

        const reduced = multiTeamTradeReducer(prefilled, {
            type: 'set-faab', memberId: 'A', toMemberId: 'B', value: String(MAX_TRADE_FAAB_AMOUNT),
        })
        expect(reduced.participants.A.faabInputs.B).toBe(String(MAX_TRADE_FAAB_AMOUNT))
        expect(isMultiTeamTradeSubmittable(
            reduced.participantOrder,
            buildMultiTeamTradeItems(reduced, true),
        )).toBe(true)
    })

    it('requires every selected participant to send or receive an asset before submission', () => {
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { kind: 'player', fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
        ])).toBe(false)
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { kind: 'player', fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
            { kind: 'pick', fromMemberId: 'C', toMemberId: 'A', pickId: 'pick-1' },
        ])).toBe(true)
    })

    it('rejects malformed assetless, mixed, and non-positive routes at runtime', () => {
        const valid = { kind: 'pick', fromMemberId: 'C', toMemberId: 'A', pickId: 'pick-1' }
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { kind: 'player', fromMemberId: 'A', toMemberId: 'B' },
            valid,
        ])).toBe(false)
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { kind: 'player', fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1', pickId: 'pick-2' },
            valid,
        ])).toBe(false)
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { kind: 'faab', fromMemberId: 'A', toMemberId: 'B', faabAmount: 0 },
            valid,
        ])).toBe(false)
    })

    it('sets an exact two-team specialization without discarding selected assets', () => {
        let state = multiTeamTradeReducer(createMultiTeamTradeState('A'), {
            type: 'set-participants',
            actorMemberId: 'A',
            participantIds: ['A', 'B'],
        })
        state = multiTeamTradeReducer(state, { type: 'select-asset', asset: 'player', memberId: 'A', assetId: 'player-1' })
        state = multiTeamTradeReducer(state, {
            type: 'set-participants',
            actorMemberId: 'A',
            participantIds: ['A', 'B'],
        })

        expect(state.participantOrder).toEqual(['A', 'B'])
        expect(buildMultiTeamTradeItems(state, false)).toEqual([
            { kind: 'player', fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
        ])
    })
    it('keeps selected assets on the current default route until explicitly overridden', () => {
        let state = addParticipant(addParticipant(createMultiTeamTradeState('A'), 'B'), 'C')
        state = multiTeamTradeReducer(state, { type: 'toggle-asset', asset: 'player', memberId: 'A', assetId: 'player-1' })
        expect(buildMultiTeamTradeItems(state, false)[0]).toMatchObject({ toMemberId: 'B' })

        state = multiTeamTradeReducer(state, { type: 'set-default-destination', memberId: 'A', toMemberId: 'C' })
        expect(buildMultiTeamTradeItems(state, false)[0]).toMatchObject({ toMemberId: 'C' })

        state = multiTeamTradeReducer(state, {
            type: 'set-asset-destination',
            asset: 'player',
            memberId: 'A',
            assetId: 'player-1',
            toMemberId: 'B',
        })
        state = multiTeamTradeReducer(state, { type: 'set-default-destination', memberId: 'A', toMemberId: 'C' })
        expect(buildMultiTeamTradeItems(state, false)[0]).toMatchObject({ toMemberId: 'B' })
    })

    it('removes invalid route overrides with a removed participant', () => {
        let state = addParticipant(addParticipant(createMultiTeamTradeState('A'), 'B'), 'C')
        state = multiTeamTradeReducer(state, { type: 'toggle-asset', asset: 'pick', memberId: 'A', assetId: 'pick-1' })
        state = multiTeamTradeReducer(state, {
            type: 'set-asset-destination',
            asset: 'pick',
            memberId: 'A',
            assetId: 'pick-1',
            toMemberId: 'B',
        })
        state = multiTeamTradeReducer(state, {
            type: 'toggle-participant',
            memberId: 'B',
            actorMemberId: 'A',
            availableMemberIds: members,
        })

        expect(state.participantOrder).toEqual(['A', 'C'])
        expect(buildMultiTeamTradeItems(state, false)[0]).toMatchObject({ toMemberId: 'C' })
    })

    it('prefills routed players, picks, and FAAB for a countering participant', () => {
        const state = multiTeamTradeStateFromTrade(routedTrade([
            {
                kind: 'player',
                playerId: 'player-1',
                playerName: 'Player One',
                position: 'PG',
                eligiblePositions: ['PG'],
                nbaTeam: 'LAL',
                nbaId: null,
                injuryStatus: null,
                yearsExp: 1,
                fromMemberId: 'A',
                toMemberId: 'C',
            },
            { kind: 'pick', pickId: 'pick-1', seasonYear: 2028, round: 1, originalTeamName: 'B Team', fromMemberId: 'B', toMemberId: 'C' },
            { kind: 'faab', amount: 12, fromMemberId: 'C', toMemberId: 'A' },
        ]), 'B')

        expect(state.participantOrder).toEqual(['B', 'A', 'C'])
        expect(buildMultiTeamTradeItems(state, true)).toEqual(expect.arrayContaining([
            expect.objectContaining({ playerId: 'player-1', fromMemberId: 'A', toMemberId: 'C' }),
            expect.objectContaining({ pickId: 'pick-1', fromMemberId: 'B', toMemberId: 'C' }),
            expect.objectContaining({ faabAmount: 12, fromMemberId: 'C', toMemberId: 'A' }),
        ]))
    })

    it('round-trips an explicit FAAB route that differs from the sender default', () => {
        const state = multiTeamTradeStateFromTrade(routedTrade([
            {
                kind: 'player', playerId: 'player-1', playerName: 'Player One', position: 'PG',
                eligiblePositions: ['PG'], nbaTeam: 'LAL', nbaId: null, injuryStatus: null, yearsExp: 1,
                fromMemberId: 'A', toMemberId: 'C',
            },
            { kind: 'faab', amount: 9, fromMemberId: 'A', toMemberId: 'B' },
        ]), 'A')

        expect(buildMultiTeamTradeItems(state, true)).toEqual(expect.arrayContaining([
            expect.objectContaining({ playerId: 'player-1', fromMemberId: 'A', toMemberId: 'C' }),
            expect.objectContaining({ faabAmount: 9, fromMemberId: 'A', toMemberId: 'B' }),
        ]))
    })

    it('round-trips multiple FAAB destinations from the same sender without merging routes', () => {
        const state = multiTeamTradeStateFromTrade(routedTrade([
            { kind: 'faab', amount: 5, fromMemberId: 'A', toMemberId: 'B' },
            { kind: 'faab', amount: 7, fromMemberId: 'A', toMemberId: 'C' },
        ]), 'A')

        expect(buildMultiTeamTradeItems(state, true)).toEqual(expect.arrayContaining([
            { kind: 'faab', fromMemberId: 'A', toMemberId: 'B', faabAmount: 5 },
            { kind: 'faab', fromMemberId: 'A', toMemberId: 'C', faabAmount: 7 },
        ]))
        expect(buildMultiTeamTradeItems(state, true)).toHaveLength(2)
    })
})
