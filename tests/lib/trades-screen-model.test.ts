import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { isTradeVisibleOnScreen, type Trade } from '@/lib/trades'

const NOW = Date.parse('2026-07-09T12:00:00Z')

function trade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 'trade-1',
        status: 'pending',
        proposedAt: '2026-07-09T10:00:00Z',
        acceptedAt: null,
        vetoWindowExpiresAt: null,
        completedAt: null,
        vetoedAt: null,
        expiresAt: null,
        notes: null,
        proposerMemberId: 'proposer',
        proposerTeamName: 'Proposer',
        recipientMemberId: 'recipient',
        recipientTeamName: 'Recipient',
        isMultiTeam: false,
        participants: [],
        parentTradeId: null,
        counteredFromTradeId: null,
        editedFromTradeId: null,
        replacedByTradeId: null,
        version: 1,
        proposerFaabAmount: 0,
        recipientFaabAmount: 0,
        myVetoed: false,
        routedItems: [],
        ...overrides,
    }
}

describe('trade screen read model', () => {
    it('keeps every trade involving the current member', () => {
        expect(isTradeVisibleOnScreen(trade(), 'proposer', NOW)).toBe(true)
        expect(isTradeVisibleOnScreen(trade({
            isMultiTeam: true,
            participants: [{ memberId: 'third', teamName: 'Third', sortOrder: 2, isInitiator: false, acceptedAt: null }],
        }), 'third', NOW)).toBe(true)
    })

    it('includes only live veto windows for nonparticipants', () => {
        expect(isTradeVisibleOnScreen(trade({
            status: 'accepted',
            vetoWindowExpiresAt: '2026-07-09T13:00:00Z',
        }), 'observer', NOW)).toBe(true)
        expect(isTradeVisibleOnScreen(trade({
            status: 'accepted',
            vetoWindowExpiresAt: '2026-07-09T11:00:00Z',
        }), 'observer', NOW)).toBe(false)
        expect(isTradeVisibleOnScreen(trade(), 'observer', NOW)).toBe(false)
    })
})
