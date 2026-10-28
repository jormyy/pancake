import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { isTradeVisibleOnScreen, type Trade } from '@/lib/trades'
import { normalizeTradeTab } from '@/lib/trade-ui-model'
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

    // Review round 2, S11: a failed load must not render "No incoming offers."
    // under the error banner; the picks tab already hides its list on error.
    it('emits no empty rows while the resource is in error', () => {
        const failed = buildTradeList({ ...listBase, tab: 'offers', tradesError: true })
        expect(failed.filter((row) => row._type === 'empty')).toEqual([])
        expect(failed.filter((row) => row._type === 'header').map((row) => row.label)).toEqual(['Incoming'])
        const block = buildTradeList({ ...listBase, tab: 'block', blockError: true })
        expect(block.some((row) => row._type === 'empty')).toBe(false)
        const history = buildTradeList({ ...listBase, tab: 'history', tradesError: true })
        expect(history.some((row) => row._type === 'empty')).toBe(false)
        // Real rows keep rendering under the banner; only the empty rows go.
        const withRows = buildTradeList({ ...listBase, tab: 'offers', tradesError: true, incomingTrades: [trade({ id: 'live' })] })
        expect(withRows.some((row) => row._type === 'trade' && row.trade.id === 'live')).toBe(true)
        expect(withRows.some((row) => row._type === 'empty')).toBe(false)
        // Without an error the empty rows are back.
        expect(buildTradeList({ ...listBase, tab: 'offers' }).filter((row) => row._type === 'empty')).toHaveLength(1)
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
            updatedAt: '2026-07-09T10:00:00Z', asset: { kind: 'pick', pickId: 'pick-a', seasonYear: 2027, round: 1, originalTeamName: 'A' },
        }], 'recipient')
        expect(sections.incomingTrades.map((item) => item.id)).toEqual(['incoming'])
        expect(sections.outgoingTrades.map((item) => item.id)).toEqual(['outgoing'])
        expect(sections.historyTrades.map((item) => item.id)).toEqual(['history'])
        expect(sections.myBlockItems.map((item) => item.id)).toEqual(['block'])
    })

    it('lists other teams before your listings without duplicating owned assets', () => {
        const mine = { id: 'mine', memberId: 'recipient', teamName: 'Recipient', note: null,
            updatedAt: '2026-07-09T10:00:00Z', asset: { kind: 'pick' as const, pickId: 'pick-a', seasonYear: 2027, round: 1, originalTeamName: 'A' } }
        const other = { ...mine, id: 'other', memberId: 'other' }
        const rows = buildTradeList({ ...listBase, tab: 'block', myBlockItems: [mine], leagueBlockItems: [mine, other] })
        expect(rows.map(row => row._type === 'header' ? row.label : row._type === 'blockItem' ? row.item.id : row._type))
            .toEqual(['League listings', 'other', 'Your listings', 'mine'])
    })

    it('redirects removed trade sections to their current sections', () => {
        for (const alias of ['picks']) expect(normalizeTradeTab(alias)).toBe('offers')
        for (const alias of ['leagueBlock', 'my-block']) expect(normalizeTradeTab(alias)).toBe('block')
    })

    it('assigns each tab to exactly one retryable resource owner', () => {
        expect(tradeScreenResource('block')).toBe('block')
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
