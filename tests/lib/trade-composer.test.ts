import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    buildTradeComposerPayload,
    buildTwoTeamTradeComposerPayload,
    getTradeComposerMode,
    prefillTradeComposerFromTrade,
    submitMultiTeamTradeComposer,
    submitTradeComposer,
} from '@/lib/trade-composer'
import type { Trade } from '@/lib/trades'
import { endOfETDayUTC } from '@/lib/shared/dates'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z')

afterEach(() => {
    vi.useRealTimers()
})

function trade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 'trade-1',
        status: 'pending',
        proposedAt: '2026-01-01T00:00:00.000Z',
        acceptedAt: null,
        vetoWindowExpiresAt: null,
        completedAt: null,
        vetoedAt: null,
        expiresAt: new Date(NOW_MS + 2 * DAY_MS).toISOString(),
        notes: 'Make it work',
        proposerMemberId: 'proposer',
        proposerTeamName: 'Proposer Team',
        recipientMemberId: 'recipient',
        recipientTeamName: 'Recipient Team',
        parentTradeId: null,
        counteredFromTradeId: null,
        editedFromTradeId: null,
        replacedByTradeId: null,
        version: 1,
        proposerFaabAmount: 7,
        recipientFaabAmount: 3,
        myVetoed: false,
        isMultiTeam: false,
        participants: [],
        routedItems: [],
        proposerGives: [
            { kind: 'player', playerId: 'p-offer', playerName: 'Offer Player', position: 'G', nbaTeam: 'LAL' },
            { kind: 'pick', pickId: 'pick-offer', seasonYear: 2028, round: 1, originalTeamName: 'A' },
        ],
        recipientGives: [
            { kind: 'player', playerId: 'p-request', playerName: 'Request Player', position: 'F', nbaTeam: 'BOS' },
            { kind: 'pick', pickId: 'pick-request', seasonYear: 2029, round: 2, originalTeamName: 'B' },
        ],
        ...overrides,
    }
}

describe('getTradeComposerMode', () => {
    it('prioritizes edit mode and exposes the source trade id', () => {
        expect(getTradeComposerMode({ editTradeId: 'edit-1', counterTradeId: 'counter-1' })).toEqual({
            mode: 'edit',
            editTradeId: 'edit-1',
            counterTradeId: 'counter-1',
            sourceTradeId: 'edit-1',
        })
    })
})

describe('prefillTradeComposerFromTrade', () => {
    it('preserves offer and request sides when editing', () => {
        const prefill = prefillTradeComposerFromTrade('edit', trade(), NOW_MS)

        expect(prefill.selectedRecipientId).toBe('recipient')
        expect(prefill.offerPlayerIds).toEqual(['p-offer'])
        expect(prefill.offerPickIds).toEqual(['pick-offer'])
        expect(prefill.requestPlayerIds).toEqual(['p-request'])
        expect(prefill.requestPickIds).toEqual(['pick-request'])
        expect(prefill.offerFaabInput).toBe('7')
        expect(prefill.requestFaabInput).toBe('3')
        expect(prefill.expirationDays).toBe('2')
    })

    it('reverses sides and FAAB amounts when countering', () => {
        const prefill = prefillTradeComposerFromTrade('counter', trade(), NOW_MS)

        expect(prefill.selectedRecipientId).toBe('proposer')
        expect(prefill.offerPlayerIds).toEqual(['p-request'])
        expect(prefill.offerPickIds).toEqual(['pick-request'])
        expect(prefill.requestPlayerIds).toEqual(['p-offer'])
        expect(prefill.requestPickIds).toEqual(['pick-offer'])
        expect(prefill.offerFaabInput).toBe('3')
        expect(prefill.requestFaabInput).toBe('7')
    })
})

describe('buildTradeComposerPayload', () => {
    it('derives a two-team payload from the canonical routed model', () => {
        const draft = buildTwoTeamTradeComposerPayload([
            { fromMemberId: 'me', toMemberId: 'them', playerId: 'player-1' },
            { fromMemberId: 'me', toMemberId: 'them', faabAmount: 7 },
            { fromMemberId: 'them', toMemberId: 'me', pickId: 'pick-1' },
            { fromMemberId: 'them', toMemberId: 'me', faabAmount: 3 },
        ], 'me', 'them', {
            notes: ' routed ',
            expirationDaysInput: '3',
        }, NOW_MS)

        expect(draft.hasOffer).toBe(true)
        expect(draft.hasRequest).toBe(true)
        expect(draft.payload).toMatchObject({
            offerPlayerIds: ['player-1'],
            requestPickIds: ['pick-1'],
            offerFaabAmount: 7,
            requestFaabAmount: 3,
            notes: 'routed',
        })
    })
    it('parses assets, FAAB, notes, and expiration deterministically', () => {
        const draft = buildTradeComposerPayload({
            offerPlayerIds: new Set(['p1']),
            requestPlayerIds: [],
            offerPickIds: [],
            requestPickIds: new Set(['pick1']),
            notes: '  hello  ',
            offerFaabInput: '12',
            requestFaabInput: 'bad',
            expirationDaysInput: '4',
        }, NOW_MS)

        expect(draft.hasOffer).toBe(true)
        expect(draft.hasRequest).toBe(true)
        expect(draft.payload).toEqual({
            offerPlayerIds: ['p1'],
            requestPlayerIds: [],
            offerPickIds: [],
            requestPickIds: ['pick1'],
            notes: 'hello',
            expiresAt: new Date(NOW_MS + 4 * DAY_MS).toISOString(),
            offerFaabAmount: 12,
            requestFaabAmount: 0,
        })
    })

    it('omits expiration when the days field is blank', () => {
        const draft = buildTradeComposerPayload({
            offerPlayerIds: ['p1'],
            requestPlayerIds: ['p2'],
            offerPickIds: [],
            requestPickIds: [],
            notes: '',
            offerFaabInput: '0',
            requestFaabInput: '0',
            expirationDaysInput: '',
        }, NOW_MS)

        expect(draft.payload.expiresAt).toBeNull()
    })

    it('clamps active-season expirations to the trade deadline date', () => {
        const deadline = '2026-01-02'
        const draft = buildTradeComposerPayload({
            offerPlayerIds: ['p1'],
            requestPlayerIds: ['p2'],
            offerPickIds: [],
            requestPickIds: [],
            notes: '',
            offerFaabInput: '0',
            requestFaabInput: '0',
            expirationDaysInput: '7',
            leagueStatus: 'active',
            tradeDeadline: deadline,
        }, NOW_MS)

        expect(draft.payload.expiresAt).toBe(new Date(Date.parse(endOfETDayUTC(deadline)) - 1).toISOString())
    })

    it('does not clamp offseason expirations to a stale trade deadline', () => {
        const draft = buildTradeComposerPayload({
            offerPlayerIds: ['p1'],
            requestPlayerIds: ['p2'],
            offerPickIds: [],
            requestPickIds: [],
            notes: '',
            offerFaabInput: '0',
            requestFaabInput: '0',
            expirationDaysInput: '7',
            leagueStatus: 'offseason',
            tradeDeadline: '2026-01-02',
        }, NOW_MS)

        expect(draft.payload.expiresAt).toBe(new Date(NOW_MS + 7 * DAY_MS).toISOString())
    })
})

describe('submitTradeComposer', () => {
    it('loads the current season and calls proposeTrade for new offers', async () => {
        const getCurrentSeasonId = vi.fn().mockResolvedValue('season-1')
        const proposeTrade = vi.fn().mockResolvedValue('trade-2')
        const counterTrade = vi.fn().mockResolvedValue('counter-2')
        const editTrade = vi.fn().mockResolvedValue('edit-2')
        const payload = buildTradeComposerPayload({
            offerPlayerIds: ['p1'],
            requestPlayerIds: ['p2'],
            offerPickIds: [],
            requestPickIds: [],
            notes: '',
            offerFaabInput: '0',
            requestFaabInput: '0',
            expirationDaysInput: '3',
        }, NOW_MS).payload

        await submitTradeComposer({
            mode: 'propose',
            editTradeId: null,
            counterTradeId: null,
            myMemberId: 'me',
            leagueId: 'league-1',
            selectedRecipientId: 'them',
            payload,
        }, { getCurrentSeasonId, proposeTrade, counterTrade, editTrade })

        expect(getCurrentSeasonId).toHaveBeenCalledWith('league-1')
        expect(proposeTrade).toHaveBeenCalledWith(
            'me',
            'league-1',
            'season-1',
            'them',
            ['p1'],
            ['p2'],
            [],
            [],
            undefined,
            { expiresAt: payload.expiresAt, offerFaabAmount: 0, requestFaabAmount: 0 },
        )
        expect(counterTrade).not.toHaveBeenCalled()
        expect(editTrade).not.toHaveBeenCalled()
    })

    it('routes counters without loading a season', async () => {
        const getCurrentSeasonId = vi.fn().mockResolvedValue('season-1')
        const proposeTrade = vi.fn().mockResolvedValue('trade-2')
        const counterTrade = vi.fn().mockResolvedValue('counter-2')
        const editTrade = vi.fn().mockResolvedValue('edit-2')
        const payload = buildTradeComposerPayload({
            offerPlayerIds: ['p1'],
            requestPlayerIds: ['p2'],
            offerPickIds: [],
            requestPickIds: [],
            notes: 'counter',
            offerFaabInput: '5',
            requestFaabInput: '0',
            expirationDaysInput: '3',
        }, NOW_MS).payload

        await submitTradeComposer({
            mode: 'counter',
            editTradeId: null,
            counterTradeId: 'trade-1',
            myMemberId: 'me',
            leagueId: 'league-1',
            selectedRecipientId: 'them',
            payload,
        }, { getCurrentSeasonId, proposeTrade, counterTrade, editTrade })

        expect(counterTrade).toHaveBeenCalledWith('trade-1', 'me', payload)
        expect(getCurrentSeasonId).not.toHaveBeenCalled()
        expect(proposeTrade).not.toHaveBeenCalled()
        expect(editTrade).not.toHaveBeenCalled()
    })
})

describe('submitMultiTeamTradeComposer', () => {
    it('loads the current season and submits routed assets with a deadline-clamped expiration', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(NOW_MS))
        const getCurrentSeasonId = vi.fn().mockResolvedValue('season-1')
        const proposeMultiTeamTrade = vi.fn().mockResolvedValue('trade-2')
        const counterMultiTeamTrade = vi.fn()
        const editMultiTeamTrade = vi.fn()
        const deadline = '2026-01-02'
        const items = [
            { fromMemberId: 'me', toMemberId: 'them', playerId: 'player-1' },
            { fromMemberId: 'third', toMemberId: 'me', faabAmount: 12 },
        ]

        await submitMultiTeamTradeComposer({
            mode: 'propose',
            editTradeId: null,
            counterTradeId: null,
            myMemberId: 'me',
            leagueId: 'league-1',
            participantMemberIds: ['me', 'them', 'third'],
            items,
            notes: '  multi team deal  ',
            expirationDays: '7',
            leagueStatus: 'active',
            tradeDeadline: deadline,
        }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })

        expect(getCurrentSeasonId).toHaveBeenCalledWith('league-1')
        expect(proposeMultiTeamTrade).toHaveBeenCalledWith('me', 'league-1', 'season-1', {
            participantMemberIds: ['me', 'them', 'third'],
            items,
            notes: 'multi team deal',
            expiresAt: new Date(Date.parse(endOfETDayUTC(deadline)) - 1).toISOString(),
        })
        expect(counterMultiTeamTrade).not.toHaveBeenCalled()
        expect(editMultiTeamTrade).not.toHaveBeenCalled()
    })

    it('does not submit a multi-team offer without an active season', async () => {
        const getCurrentSeasonId = vi.fn().mockResolvedValue(null)
        const proposeMultiTeamTrade = vi.fn().mockResolvedValue('trade-2')
        const counterMultiTeamTrade = vi.fn()
        const editMultiTeamTrade = vi.fn()

        await expect(submitMultiTeamTradeComposer({
            mode: 'propose',
            editTradeId: null,
            counterTradeId: null,
            myMemberId: 'me',
            leagueId: 'league-1',
            participantMemberIds: ['me', 'them'],
            items: [{ fromMemberId: 'me', toMemberId: 'them', pickId: 'pick-1' }],
            notes: '',
            expirationDays: '3',
        }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })).rejects.toThrow('No active season found.')

        expect(proposeMultiTeamTrade).not.toHaveBeenCalled()
        expect(counterMultiTeamTrade).not.toHaveBeenCalled()
        expect(editMultiTeamTrade).not.toHaveBeenCalled()
    })

    it('submits multi-team counters and edits without looking up the current season', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(NOW_MS))
        const getCurrentSeasonId = vi.fn()
        const proposeMultiTeamTrade = vi.fn()
        const counterMultiTeamTrade = vi.fn().mockResolvedValue('counter-2')
        const editMultiTeamTrade = vi.fn().mockResolvedValue('edit-2')
        const items = [{ fromMemberId: 'me', toMemberId: 'them', playerId: 'player-1' }]

        await submitMultiTeamTradeComposer({
            mode: 'counter',
            editTradeId: null,
            counterTradeId: 'trade-1',
            myMemberId: 'me',
            leagueId: 'league-1',
            participantMemberIds: ['me', 'them'],
            items,
            notes: ' counter ',
            expirationDays: '3',
        }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })

        await submitMultiTeamTradeComposer({
            mode: 'edit',
            editTradeId: 'trade-2',
            counterTradeId: null,
            myMemberId: 'me',
            leagueId: 'league-1',
            participantMemberIds: ['me', 'them'],
            items,
            notes: ' edit ',
            expirationDays: '3',
        }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })

        expect(getCurrentSeasonId).not.toHaveBeenCalled()
        expect(proposeMultiTeamTrade).not.toHaveBeenCalled()
        expect(counterMultiTeamTrade).toHaveBeenCalledWith('trade-1', 'me', {
            participantMemberIds: ['me', 'them'],
            items,
            notes: 'counter',
            expiresAt: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
        expect(editMultiTeamTrade).toHaveBeenCalledWith('trade-2', 'me', {
            participantMemberIds: ['me', 'them'],
            items,
            notes: 'edit',
            expiresAt: new Date(NOW_MS + 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
    })
})
