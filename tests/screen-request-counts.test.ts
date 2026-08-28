import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPlayerAvailabilitySnapshot } from '@/lib/player-availability'
import { getMemberTransactionState } from '@/lib/league'
import { getRoster, getPlayerRosterStatus, pickupPossible } from '@/lib/roster'
import { getRosterStatsMaps } from '@/lib/roster-stats'
import { getTradeBlockItems, getTradeHistoryForScreen, getTradesForScreen } from '@/lib/trades'
import { invalidateSeasonCache } from '@/lib/shared/season'

// Request budget per screen load: every Supabase table read or RPC the data
// layer issues for a workflow, counted through a filter-aware fake client.
// Lowering a number here is an improvement; raising one is a regression that
// needs a reason in the same change.

type Row = Record<string, unknown>
const counts = vi.hoisted(() => new Map<string, number>())
const fixtures = vi.hoisted((): Record<string, Row[]> => ({}))

vi.mock('@/lib/supabase', () => {
    const applyFilters = (rows: Row[], filters: [string, unknown[]][]) => rows.filter((row) => filters.every(([op, args]) => {
        const [column, value] = args as [string, unknown]
        if (!(column in row)) return true
        if (op === 'eq') return row[column] === value
        if (op === 'neq') return row[column] !== value
        if (op === 'in') return (value as unknown[]).includes(row[column])
        if (op === 'is') return row[column] === value
        return true
    }))
    const builder = (target: string) => {
        counts.set(target, (counts.get(target) ?? 0) + 1)
        const filters: [string, unknown[]][] = []
        let single = false
        const proxy: Record<string, unknown> = new Proxy({}, {
            get(_, prop: string) {
                if (prop === 'then') {
                    return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
                        const rows = applyFilters(fixtures[target] ?? [], filters)
                        const data = single ? rows[0] ?? null : rows
                        return Promise.resolve({ data, error: null }).then(resolve, reject)
                    }
                }
                return (...args: unknown[]) => {
                    if (prop === 'maybeSingle' || prop === 'single') single = true
                    if (['eq', 'neq', 'in', 'is'].includes(prop)) filters.push([prop, args])
                    return proxy
                }
            },
        })
        return proxy
    }
    return {
        supabase: {
            from: (table: string) => builder(table),
            rpc: (name: string) => builder(`rpc:${name}`),
        },
    }
})

const player = (id: string) => ({
    id, display_name: `Player ${id}`, nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'],
    injury_status: null, nba_id: id, nba_draft_number: null, years_exp: 3,
})
const iso = '2026-08-27T00:00:00.000Z'

function seedFixtures() {
    fixtures.league_seasons = [{ id: 'season', season_year: 2098, league_id: 'league', is_current: true }]
    fixtures.roster_players = [
        { id: 'rp-1', league_id: 'league', league_season_id: 'season', member_id: 'member', player_id: 'p-1', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft', league_members: { team_name: 'Mine' }, players: player('p-1') },
        { id: 'rp-2', league_id: 'league', league_season_id: 'season', member_id: 'other', player_id: 'p-2', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft', league_members: { team_name: 'Theirs' }, players: player('p-2') },
    ]
    fixtures.waiver_wire_log = [{ id: 'log-1', league_id: 'league', league_season_id: 'season', player_id: 'p-9', clears_at: '2099-01-01T00:00:00.000Z', cleared_at: null }]
    fixtures['rpc:get_member_transaction_state'] = [{
        league_season_id: 'season', week_number: 3, weekly_add_limit: 7, weekly_add_count: 2, waiver_mode: 'faab',
        faab_starting_budget: 100, faab_balance: 60, add_limit_resets_at: null, add_week_timezone: 'America/New_York',
    }]
    fixtures.trade_block_items = [{
        id: 'tb-1', league_id: 'league', member_id: 'member', player_id: 'p-1', pick_id: null, note: null, updated_at: iso,
        league_members: { team_name: 'Mine' }, players: player('p-1'), draft_picks: null,
    }]
    fixtures.v_player_avg_fantasy_points = [{ player_id: 'p-1', avg_fantasy_points: 30 }]
    fixtures.mv_player_season_averages = [{ player_id: 'p-1', avg_points: 20, avg_rebounds: 5, avg_assists: 4, avg_steals: 1, avg_blocks: 1, avg_three_pointers_made: 2, avg_turnovers: 2, avg_minutes_played: 30, games_played: 10 }]
    fixtures['rpc:get_trade_page_refs'] = [{ trade_id: 't-1', cursor_token: 'c1' }]
    fixtures.trades = [{
        id: 't-1', league_id: 'league', status: 'completed', proposed_at: iso, accepted_at: iso, veto_window_expires_at: iso, completed_at: iso,
        vetoed_at: null, expires_at: null, notes: null, proposer_member_id: 'member', recipient_member_id: 'other', is_multi_team: false,
        parent_trade_id: null, countered_from_trade_id: null, edited_from_trade_id: null, replaced_by_trade_id: null, version: 1,
        proposer_faab_amount: 0, recipient_faab_amount: 0, proposer: { team_name: 'Mine' }, recipient: { team_name: 'Theirs' },
        trade_vetos: [], trade_participants: [],
        trade_items: [{ side: 'proposer', player_id: 'p-1', pick_id: null, from_member_id: 'member', to_member_id: 'other', faab_amount: 0, players: player('p-1'), draft_picks: null }],
    }]
    fixtures.trade_participants = [{ trade_id: 't-1', league_id: 'league', member_id: 'member', proposed_at: iso, trades: { status: 'completed' } }]
}

async function measure(run: () => Promise<unknown>) {
    counts.clear()
    invalidateSeasonCache()
    await run()
    const byTarget = Object.fromEntries([...counts.entries()].sort())
    return { requests: [...counts.values()].reduce((sum, n) => sum + n, 0), byTarget }
}

beforeEach(seedFixtures)

describe('screen request budgets', () => {
    it('players tab support load (availability + transaction state)', async () => {
        const result = await measure(() => Promise.all([
            getPlayerAvailabilitySnapshot('league'),
            getMemberTransactionState('member', 'league'),
        ]))
        expect(result).toEqual({
            requests: 4,
            byTarget: { league_seasons: 1, roster_players: 1, 'rpc:get_member_transaction_state': 1, waiver_wire_log: 1 },
        })
    })

    it('trade block tab load (listings + own roster + one averages fetch for both)', async () => {
        const result = await measure(async () => {
            const [items, roster] = await Promise.all([getTradeBlockItems('league'), getRoster('member', 'league')])
            await getRosterStatsMaps([
                ...items.flatMap((item) => item.asset.kind === 'player' ? [item.asset.playerId] : []),
                ...roster.map((row) => row.players.id),
            ], 'league')
            return items
        })
        expect(result).toEqual({
            requests: 5,
            byTarget: { league_seasons: 1, mv_player_season_averages: 1, roster_players: 1, trade_block_items: 1, v_player_avg_fantasy_points: 1 },
        })
    })

    it('trades offers page', async () => {
        const result = await measure(() => getTradesForScreen('member', 'league'))
        expect(result).toEqual({
            requests: 4,
            byTarget: { mv_player_season_averages: 1, 'rpc:get_trade_page_refs': 1, trades: 1, v_player_avg_fantasy_points: 1 },
        })
    })

    it('trade history page', async () => {
        const result = await measure(() => getTradeHistoryForScreen('member', 'league'))
        expect(result).toEqual({
            requests: 4,
            byTarget: { mv_player_season_averages: 1, trade_participants: 1, trades: 1, v_player_avg_fantasy_points: 1 },
        })
    })

    it('player page pickup state for a rostered player and for a free agent', async () => {
        // The player page loads the weekly add state only once the player turns
        // out to be pick-up-able, so a rostered player costs no extra request.
        const load = async (playerId: string) => {
            const status = await getPlayerRosterStatus(playerId, 'member', 'league')
            if (pickupPossible(status)) await getMemberTransactionState('member', 'league')
        }
        const rostered = await measure(() => load('p-1'))
        expect(rostered).toEqual({
            requests: 2,
            byTarget: { league_seasons: 1, roster_players: 1 },
        })
        const freeAgent = await measure(() => load('p-7'))
        expect(freeAgent).toEqual({
            requests: 4,
            byTarget: { league_seasons: 1, roster_players: 1, 'rpc:get_member_transaction_state': 1, waiver_wire_log: 1 },
        })
    })
})
