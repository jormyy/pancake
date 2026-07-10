import { describe, expect, it } from 'vitest'
import {
    buildMultiTeamTradeItems,
    createMultiTeamTradeState,
    isMultiTeamTradeSubmittable,
    multiTeamTradeReducer,
    multiTeamTradeStateFromTrade,
} from '@/lib/multi-team-trade-state'
import type { RoutedTradeItem, Trade } from '@/lib/trades'

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
    it('requires every selected participant to send or receive an asset before submission', () => {
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
        ])).toBe(false)
        expect(isMultiTeamTradeSubmittable(['A', 'B', 'C'], [
            { fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
            { fromMemberId: 'C', toMemberId: 'A', pickId: 'pick-1' },
        ])).toBe(true)
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
            { fromMemberId: 'A', toMemberId: 'B', playerId: 'player-1' },
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
})
