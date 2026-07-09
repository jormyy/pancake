import { describe, expect, it } from 'vitest'
import {
    isIncomingTradeForMember,
    isOutgoingTradeForMember,
    isTradeHistoryForMember,
    isTradeParticipant,
    isVetoableTradeForMember,
    needsMemberAcceptance,
    tradeParticipantIds,
    type TradePerspectiveInput,
} from '@/lib/trade-perspective'

function trade(overrides: Partial<TradePerspectiveInput> = {}): TradePerspectiveInput {
    return {
        status: 'pending',
        proposerMemberId: 'alpha',
        recipientMemberId: 'bravo',
        participants: [],
        ...overrides,
    }
}

const acceptedAt = '2026-01-01T00:00:00.000Z'

describe('trade perspective helpers', () => {
    it('deduplicates all explicit participants and rejects blank member ids', () => {
        const input = trade({
            participants: [
                { memberId: 'bravo', acceptedAt: null },
                { memberId: 'charlie', acceptedAt },
                { memberId: 'charlie', acceptedAt },
            ],
        })

        expect(tradeParticipantIds(input)).toEqual(['alpha', 'bravo', 'charlie'])
        expect(isTradeParticipant(input, 'charlie')).toBe(true)
        expect(isTradeParticipant(input, '')).toBe(false)
        expect(isTradeParticipant(input, 'delta')).toBe(false)
    })

    it('requires pending recipients to accept classic two-team trades', () => {
        const input = trade()

        expect(needsMemberAcceptance(input, 'bravo')).toBe(true)
        expect(isIncomingTradeForMember(input, 'bravo')).toBe(true)
        expect(needsMemberAcceptance(input, 'alpha')).toBe(false)
        expect(needsMemberAcceptance(input, 'charlie')).toBe(false)
        expect(needsMemberAcceptance(trade({ status: 'accepted' }), 'bravo')).toBe(false)
    })

    it('uses per-participant acceptance rows for multi-team pending trades', () => {
        const input = trade({
            participants: [
                { memberId: 'alpha', acceptedAt: null },
                { memberId: 'bravo', acceptedAt: null },
                { memberId: 'charlie', acceptedAt },
                { memberId: 'delta', acceptedAt: null },
            ],
        })

        expect(needsMemberAcceptance(input, 'bravo')).toBe(true)
        expect(needsMemberAcceptance(input, 'delta')).toBe(true)
        expect(needsMemberAcceptance(input, 'charlie')).toBe(false)
        expect(needsMemberAcceptance(input, 'alpha')).toBe(true)
    })

    it('classifies outgoing pending trades for proposers and already-accepted participants', () => {
        const input = trade({
            participants: [
                { memberId: 'alpha', acceptedAt },
                { memberId: 'bravo', acceptedAt: null },
                { memberId: 'charlie', acceptedAt },
            ],
        })

        expect(isOutgoingTradeForMember(input, 'alpha')).toBe(true)
        expect(isOutgoingTradeForMember(input, 'charlie')).toBe(true)
        expect(isOutgoingTradeForMember(input, 'bravo')).toBe(false)
        expect(isOutgoingTradeForMember(input, 'delta')).toBe(false)
    })

    it('keeps unaccepted multi-team proposers in the incoming acceptance queue', () => {
        const input = trade({
            participants: [
                { memberId: 'alpha', acceptedAt: null },
                { memberId: 'bravo', acceptedAt },
                { memberId: 'charlie', acceptedAt },
            ],
        })

        expect(isIncomingTradeForMember(input, 'alpha')).toBe(true)
        expect(isOutgoingTradeForMember(input, 'alpha')).toBe(false)
    })

    it('shows accepted trades in participant history while reserving vetoes for non-participants', () => {
        const input = trade({
            status: 'accepted',
            participants: [
                { memberId: 'alpha', acceptedAt },
                { memberId: 'bravo', acceptedAt },
                { memberId: 'charlie', acceptedAt },
            ],
        })

        expect(isTradeHistoryForMember(input, 'alpha')).toBe(true)
        expect(isTradeHistoryForMember(input, 'charlie')).toBe(true)
        expect(isTradeHistoryForMember(input, 'delta')).toBe(false)
        expect(isVetoableTradeForMember(input, 'delta')).toBe(true)
        expect(isVetoableTradeForMember(input, 'charlie')).toBe(false)
    })
})
