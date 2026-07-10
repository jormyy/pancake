import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { isTradeVisibleOnScreen, type Trade, type TradePickItem } from '@/lib/trades'
import { buildTradeList, buildTradeScreenModel, selectTradeScreenSections, tradeScreenResource } from '@/lib/trades-screen-model'

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

const pick = (id: string, year: number, round: number): TradePickItem => ({
    kind: 'pick', pickId: id, seasonYear: year, round, originalTeamName: 'Team',
})

const listBase = {
    vetoableTrades: [], incomingTrades: [], outgoingTrades: [], historyTrades: [],
    picks: [], tradesLoading: false, myBlockItems: [], blockLoading: false,
    blockRoster: [], leagueBlockItems: [],
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

    it('keeps actionable veto trades ahead of incoming and outgoing sections', () => {
        const rows = buildTradeList({
            ...listBase,
            tab: 'offers',
            vetoableTrades: [trade({ id: 'veto' })],
            incomingTrades: [trade({ id: 'incoming' })],
            outgoingTrades: [trade({ id: 'outgoing' })],
        })
        expect(rows.map((row) => row._type === 'trade' ? row.trade.id : row._type === 'header' ? row.label : row._type)).toEqual([
            'Veto Window', 'veto', 'Incoming', 'incoming', 'Outgoing', 'outgoing',
        ])
    })

    it('classifies trades and owned block items in one read-model pass', () => {
        const sections = selectTradeScreenSections([
            trade({ id: 'incoming' }),
            trade({ id: 'outgoing', proposerMemberId: 'recipient', recipientMemberId: 'other' }),
            trade({ id: 'history', status: 'completed' }),
        ], [{
            id: 'block', memberId: 'recipient', teamName: 'Recipient', note: null,
            updatedAt: '2026-07-09T10:00:00Z', asset: { kind: 'faab', amount: 1 },
        }], 'recipient')
        expect(sections.incomingTrades.map((item) => item.id)).toEqual(['incoming'])
        expect(sections.outgoingTrades.map((item) => item.id)).toEqual(['outgoing'])
        expect(sections.historyTrades.map((item) => item.id)).toEqual(['history'])
        expect(sections.myBlockItems.map((item) => item.id)).toEqual(['block'])
    })

    it('sorts and groups picks by season', () => {
        const rows = buildTradeList({
            ...listBase,
            tab: 'picks',
            picks: [pick('late', 2028, 2), pick('early', 2027, 1)],
        })
        expect(rows.map((row) => row._type === 'header' ? row.label : row._type === 'pick' ? row.pick.pickId : row._type)).toEqual([
            '2027 Picks', 'early', '2028 Picks', 'late',
        ])
    })

    it('assigns each tab to exactly one retryable resource owner', () => {
        expect(tradeScreenResource('picks')).toBe('picks')
        expect(tradeScreenResource('block')).toBe('block')
        expect(tradeScreenResource('leagueBlock')).toBe('block')
        expect(tradeScreenResource('offers')).toBe('trades')
        expect(tradeScreenResource('history')).toBe('history')
    })

    it('uses the separately owned history feed without changing offer classification', () => {
        const history = trade({ id: 'history', status: 'completed' })
        const model = buildTradeScreenModel({
            ...listBase,
            tab: 'history',
            trades: [trade({ id: 'incoming' })],
            historyTrades: [history],
            blockItems: [],
            memberId: 'recipient',
        })
        expect(model.historyTrades.map(({ id }) => id)).toEqual(['history'])
        expect(model.incomingTrades.map(({ id }) => id)).toEqual(['incoming'])
    })
})
