import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

describe('shared realtime subscription coverage', () => {
    it('publishes shared league state tables with full row identity', () => {
        const migration = read('supabase/migrations/20260708000005_shared_state_realtime.sql')
        const tradeChildMigration = read('supabase/migrations/20260708000006_trade_child_realtime_league_ids.sql')

        expect(migration).toContain('ALTER TABLE public.%I REPLICA IDENTITY FULL')
        expect(migration).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I')
        for (const table of [
            'leagues',
            'league_members',
            'league_seasons',
            'roster_players',
            'roster_transactions',
            'waiver_claims',
            'waiver_priorities',
            'waiver_wire_log',
            'draft_picks',
            'snake_draft_picks',
            'draft_room_members',
            'trades',
            'trade_items',
            'trade_participants',
            'trade_vetos',
            'trade_block_items',
            'weekly_lineups',
        ]) {
            expect(migration).toContain(`'${table}'`)
        }
        expect(tradeChildMigration).toContain('ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES public.leagues(id)')
        expect(tradeChildMigration).toContain('CREATE OR REPLACE FUNCTION private.set_trade_child_league_id')
        expect(tradeChildMigration).toContain("tablename = v_table")
        expect(tradeChildMigration).toContain("'trade_vetos'")
    })

    it('wires shared app surfaces to realtime refreshes with focus refresh fallback intact', () => {
        const realtimeHelper = read('lib/realtime.ts')
        const useLeagues = read('hooks/use-leagues.ts')
        const leagueScreenState = read('hooks/use-league-screen-state.ts')
        const tradesScreen = read('app/(tabs)/trades.tsx')
        const rosterScreen = read('app/(tabs)/roster.tsx')
        const playersScreen = read('app/(tabs)/players.tsx')
        const pendingTradeCount = read('hooks/use-pending-trade-count.ts')
        const matchupData = read('hooks/use-matchup-data.ts')

        expect(realtimeHelper).toContain('function subscribeToTableChanges')
        expect(realtimeHelper).toContain("channel.on(")
        expect(realtimeHelper).toContain('function unsubscribeFromTableChanges')

        expect(useLeagues).toContain('league-context:${userId}')
        expect(useLeagues).toContain("table: 'league_members', filter: `user_id=eq.${userId}`")
        expect(useLeagues).toContain("table: 'leagues', filter: `id=eq.${leagueId}`")

        expect(leagueScreenState).toContain('league-screen:${lid}')
        expect(leagueScreenState).toContain("const refreshHistory = debounceRealtimeRefresh")
        expect(leagueScreenState).toContain("const refreshDraftBoard = debounceRealtimeRefresh")
        expect(leagueScreenState).toContain("const refreshMockRooms = debounceRealtimeRefresh")
        expect(leagueScreenState).toContain('leagueScreenWatches(lid')
        expect(leagueScreenState).toContain('draft_id=in.(')
        expect(leagueScreenState).toContain("currentDraftKey || 'none'")
        expect(leagueScreenState).toContain("table: 'snake_draft_picks'")

        expect(tradesScreen).toContain('trades-screen:${leagueId}:${myMemberId}')
        expect(tradesScreen).toContain("const refreshTrades = debounceRealtimeRefresh")
        expect(tradesScreen).toContain("const refreshTradeBlock = debounceRealtimeRefresh")
        expect(tradesScreen).toContain("const refreshDraftPicks = debounceRealtimeRefresh")
        expect(tradesScreen).toContain('tradeScreenWatches(leagueId')

        expect(rosterScreen).toContain('roster-screen:${leagueId}:${current.id}')
        expect(rosterScreen).toContain("table: 'roster_players', filter: `member_id=eq.${current.id}`")
        expect(rosterScreen).toContain("table: 'waiver_claims', filter: `member_id=eq.${current.id}`")

        expect(playersScreen).toContain('players-screen:${leagueId}')
        expect(playersScreen).toContain("table: 'waiver_wire_log', filter: `league_id=eq.${leagueId}`")
        expect(playersScreen).toContain("table: 'roster_players', filter: `league_id=eq.${leagueId}`")

        expect(pendingTradeCount).toContain('pending-trade-count:${leagueId}:${memberId}')
        expect(pendingTradeCount).toContain('getPendingIncomingTradeCount(memberId, leagueId)')
        expect(pendingTradeCount).toContain("table: 'trade_participants', filter: `league_id=eq.${leagueId}`")
        expect(pendingTradeCount).toContain("window.addEventListener('focus', fetchCount)")

        expect(matchupData).toContain("table: 'matchups'")
        expect(matchupData).toContain("table: 'weekly_lineups'")
        expect(matchupData).toContain('void refreshSilently()')
    })
})
