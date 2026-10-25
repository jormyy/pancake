import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2025) }))

import { supabase } from '@/lib/supabase'
import { playerAverageLabel } from '@/lib/player-search-state'
import { getPlayerTransactionHistory, searchPlayers } from '@/lib/players'

describe('getPlayerTransactionHistory', () => {
    const mockRow = (id: string) => ({
        id,
        transaction_type: 'add',
        occurred_at: '2025-01-01T00:00:00Z',
        league_members: { team_name: 'Team A' },
    })

    function setupMock(rows: ReturnType<typeof mockRow>[]) {
        const rangeStub = vi.fn().mockResolvedValue({ data: rows, error: null })
        const orderStub = vi.fn().mockReturnValue({ range: rangeStub })
        const eqLeagueStub = vi.fn().mockReturnValue({ order: orderStub })
        const eqPlayerStub = vi.fn().mockReturnValue({ eq: eqLeagueStub })
        const selectStub = vi.fn().mockReturnValue({ eq: eqPlayerStub })
        ;(supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectStub })
        return { rangeStub }
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('fetches first page with default limit and offset', async () => {
        const rows = [mockRow('tx1'), mockRow('tx2')]
        const { rangeStub } = setupMock(rows)

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(rangeStub).toHaveBeenCalledWith(0, 19)
        expect(result).toHaveLength(2)
        expect(result[0].id).toBe('tx1')
    })

    it('fetches second page with correct offset', async () => {
        const rows = [mockRow('tx21')]
        const { rangeStub } = setupMock(rows)

        const result = await getPlayerTransactionHistory('player-1', 'league-1', 20, 20)

        expect(rangeStub).toHaveBeenCalledWith(20, 39)
        expect(result[0].id).toBe('tx21')
    })

    it('respects custom limit', async () => {
        const rows = [mockRow('tx1')]
        const { rangeStub } = setupMock(rows)

        await getPlayerTransactionHistory('player-1', 'league-1', 10, 0)

        expect(rangeStub).toHaveBeenCalledWith(0, 9)
    })

    it('maps rows to TransactionHistoryEntry shape', async () => {
        setupMock([mockRow('tx-abc')])

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(result[0]).toMatchObject({
            id: 'tx-abc',
            transactionType: 'add',
            teamName: 'Team A',
            occurredAt: '2025-01-01T00:00:00Z',
        })
    })

    it('returns empty array when no transactions exist', async () => {
        setupMock([])

        const result = await getPlayerTransactionHistory('player-1', 'league-1')

        expect(result).toHaveLength(0)
    })
})

describe('searchPlayers', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('queries the canonical player search RPC with sort, filter, and pagination args', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: [{
                id: 'player-high',
                display_name: 'High Player',
                nba_team: 'NYK',
                position: 'SG',
                eligible_positions: ['SG'],
                status: null,
                injury_status: null,
                headshot_url: null,
                nba_id: '2',
                years_exp: 2,
                stats_season_year: 2024,
                avg_fantasy_points: 18,
                avg_points: 18,
                games_played: 2,
            }],
            error: null,
        })

        const result = await searchPlayers('high', 'G', ['NYK'], 'league-1', ['NYK', 'BOS'], false, 60, 'healthy', {
            excludedTeams: ['BOS'],
            excludePlayerIds: ['drop-me'],
        }, {
            sortMode: 'fpts',
            sortDir: 'desc',
            pageSize: 25,
        })

        expect(supabase.rpc).toHaveBeenCalledWith('search_players', {
            p_query: 'high',
            p_position: 'G',
            p_teams: ['NYK'],
            p_league_id: 'league-1',
            p_playing_teams: ['NYK', 'BOS'],
            p_excluded_teams: ['BOS'],
            p_include_player_ids: undefined,
            p_exclude_player_ids: ['drop-me'],
            p_rookies_only: false,
            p_health: 'healthy',
            p_sort_by: 'fpts',
            p_sort_dir: 'desc',
            p_season_year: undefined,
            p_limit: 25,
            p_offset: 60,
        })
        expect(result.map((player) => player.id)).toEqual(['player-high'])
        expect(result[0].stats_season_year).toBe(2024)
        expect(result[0].avg_fantasy_points).toBe(18)
    })

    it('keeps current midseason averages and the server-selected season label in Auto', async () => {
        const rows = [
            { id: 'rookie', display_name: 'R Rookie', avg_fantasy_points: 22.33, games_played: 3 },
            { id: 'high', display_name: 'Z High', avg_fantasy_points: 13.6, games_played: 5 },
            { id: 'tie', display_name: 'T Tie', avg_fantasy_points: 13.5, games_played: 4 },
            { id: 'zero', display_name: 'Y Zero', avg_fantasy_points: -2.5, games_played: 2 },
            { id: 'prior', display_name: 'B Previous', avg_fantasy_points: null, games_played: null },
        ].map(row => ({ ...row, stats_season_year: 2091 }))
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: rows, error: null })

        const result = await searchPlayers('', 'ALL', [], 'league-1', null, false, 0, 'all', {}, { seasonYear: null })

        expect(supabase.rpc).toHaveBeenLastCalledWith('search_players', expect.objectContaining({
            p_sort_by: 'fpts', p_sort_dir: 'desc', p_season_year: undefined,
        }))
        expect(result.map(row => [row.avg_fantasy_points, row.games_played])).toEqual([
            [22.33, 3], [13.6, 5], [13.5, 4], [-2.5, 2], [null, null],
        ])
        expect(result.map(row => playerAverageLabel(row.stats_season_year))).toEqual(Array(5).fill('2090–91 avg'))
        expect(result.map(row => playerAverageLabel(row.stats_season_year))).not.toContain('2089–90 avg')
    })

    it('asks for the chosen stats season and leaves automatic selection to the server', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null })

        await searchPlayers('', 'ALL', [], 'league-1', null, false, 0, 'all', {}, { seasonYear: 2023 })
        expect(supabase.rpc).toHaveBeenLastCalledWith('search_players', expect.objectContaining({ p_season_year: 2023 }))

        await searchPlayers('', 'ALL', [], 'league-1', null, false, 0, 'all', {}, { seasonYear: null })
        expect(supabase.rpc).toHaveBeenLastCalledWith('search_players', expect.objectContaining({ p_season_year: undefined }))
    })

    it('passes an explicit empty include scope so empty waiver/mine filters stay empty', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null })

        await searchPlayers('', 'ALL', [], null, null, false, 0, 'all', { includePlayerIds: [] })

        expect(supabase.rpc).toHaveBeenCalledWith('search_players', expect.objectContaining({
            p_include_player_ids: [],
        }))
    })
})
