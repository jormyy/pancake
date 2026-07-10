import { describe, expect, it } from 'vitest'
import {
    buildMultiTeamTradeItems,
    createMultiTeamTradeState,
    isMultiTeamTradeSubmittable,
    multiTeamTradeReducer,
    multiTeamTradeStateFromTrade,
} from '@/lib/multi-team-trade-state'
import type { RoutedTradeItem, Trade } from '@/lib/trades'
import { MAX_TRADE_ITEMS } from '@pancake/core'

const members = ['B', 'C']

function addParticipant(state: ReturnType<typeof createMultiTeamTradeState>, memberId: string) {
    return multiTeamTradeReducer(state, {
        type: 'toggle-participant',
        memberId,
        actorMemberId: 'A',
        availableMemberIds: members,
    })
}

function routedTrade(items: RoutedTradeItem[]): Trade {
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
        participants: ['A', 'B', 'C'].map((memberId, sortOrder) => ({
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
