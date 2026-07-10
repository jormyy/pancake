import { describe, expect, it, vi } from 'vitest'
import { leagueScreenWatches } from '@/lib/league/realtime'
import { tradeScreenWatches } from '@/lib/trades-realtime'

const callback = () => vi.fn()

describe('realtime watch groups', () => {
    it('scopes every trade screen table to the active league and routes its callback', () => {
        const refresh = {
            trades: callback(),
            tradeBlock: callback(),
            draftPicks: callback(),
        }
        const watches = tradeScreenWatches('league-1', refresh)

        expect(watches.map(({ table, filter }) => ({ table, filter }))).toEqual([
            'trades',
            'trade_items',
            'trade_participants',
            'trade_vetos',
            'trade_block_items',
            'draft_picks',
        ].map((table) => ({ table, filter: 'league_id=eq.league-1' })))
        expect(watches.map((watch) => watch.onChange)).toEqual([
            refresh.trades,
            refresh.trades,
            refresh.trades,
            refresh.trades,
            refresh.tradeBlock,
            refresh.draftPicks,
        ])
    })

    it('scopes every league screen parent table to the active league', () => {
        const refresh = {
            members: callback(),
            history: callback(),
            settings: callback(),
            draftBoard: callback(),
            drafts: callback(),
        }
        const watches = leagueScreenWatches('league-2', refresh)

        expect(watches.map(({ table, filter }) => ({ table, filter }))).toEqual([
            'league_members',
            'roster_transactions',
            'waiver_priorities',
            'draft_picks',
            'drafts',
        ].map((table) => ({ table, filter: 'league_id=eq.league-2' })))
    })
})
