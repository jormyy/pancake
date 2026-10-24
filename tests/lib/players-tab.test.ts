import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2025) }))

import { supabase } from '@/lib/supabase'
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
            p_season_year: 2025,
            p_limit: 25,
            p_offset: 60,
        })
        expect(result.map((player) => player.id)).toEqual(['player-high'])
    })

    it('asks for the chosen stats season and defaults to the current one', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null })

        await searchPlayers('', 'ALL', [], 'league-1', null, false, 0, 'all', {}, { seasonYear: 2023 })
        expect(supabase.rpc).toHaveBeenLastCalledWith('search_players', expect.objectContaining({ p_season_year: 2023 }))

        await searchPlayers('', 'ALL', [], 'league-1', null, false, 0, 'all', {}, { seasonYear: null })
        expect(supabase.rpc).toHaveBeenLastCalledWith('search_players', expect.objectContaining({ p_season_year: 2025 }))
    })

    it('passes an explicit empty include scope so empty waiver/mine filters stay empty', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null })

        await searchPlayers('', 'ALL', [], null, null, false, 0, 'all', { includePlayerIds: [] })

        expect(supabase.rpc).toHaveBeenCalledWith('search_players', expect.objectContaining({
            p_include_player_ids: [],
        }))
    })
})
