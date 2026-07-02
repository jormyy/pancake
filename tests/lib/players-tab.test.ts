import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ currentSeasonYear: vi.fn(() => 2025) }))

import { supabase } from '@/lib/supabase'
import { getPlayerGameLog, getPlayerTransactionHistory, searchPlayers } from '@/lib/players'
import { read } from '../source-guard'

// ── Pure logic helpers (extracted from component logic) ──────────────────────

function shouldShowIRModal(ineligibleIRPlayers: unknown[], _isWaiverPlayer: boolean): boolean {
    return ineligibleIRPlayers.length > 0
}

function shouldShowInjuryBadge(injuryStatus: string | null, _playedToday: boolean): boolean {
    return injuryStatus != null && injuryStatus !== ''
}

// ── IR check before waiver claim ─────────────────────────────────────────────

describe('shouldShowIRModal', () => {
    it('returns true when ineligible IR players exist and player is on waivers', () => {
        expect(shouldShowIRModal([{ id: 'p1' }], true)).toBe(true)
    })

    it('returns true when ineligible IR players exist and player is a free agent', () => {
        expect(shouldShowIRModal([{ id: 'p1' }], false)).toBe(true)
    })

    it('returns false when no ineligible IR players exist (waiver claim)', () => {
        expect(shouldShowIRModal([], true)).toBe(false)
    })

    it('returns false when no ineligible IR players exist (free agent add)', () => {
        expect(shouldShowIRModal([], false)).toBe(false)
    })

    it('returns true for multiple ineligible IR players', () => {
        expect(shouldShowIRModal([{ id: 'p1' }, { id: 'p2' }], true)).toBe(true)
    })
})

// ── Injury badge visibility ───────────────────────────────────────────────────

describe('shouldShowInjuryBadge', () => {
    it('shows badge when injury status is set and player did not play today', () => {
        expect(shouldShowInjuryBadge('Out', false)).toBe(true)
    })

    it('shows badge when injury status is set even if player played today', () => {
        expect(shouldShowInjuryBadge('DTD', true)).toBe(true)
    })

    it('shows badge for IR status regardless of playedToday', () => {
        expect(shouldShowInjuryBadge('IR', true)).toBe(true)
        expect(shouldShowInjuryBadge('IR-LTI', true)).toBe(true)
    })

    it('does not show badge when injury status is null', () => {
        expect(shouldShowInjuryBadge(null, false)).toBe(false)
        expect(shouldShowInjuryBadge(null, true)).toBe(false)
    })

    it('does not show badge when injury status is empty string', () => {
        expect(shouldShowInjuryBadge('', false)).toBe(false)
    })
})

// ── Transaction pagination ────────────────────────────────────────────────────

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

describe('getPlayerGameLog', () => {
    const gameRow = (id: string, nbaGameId: string, gameDate: string) => ({
        id,
        points: 10,
        rebounds: 3,
        offensive_rebounds: 1,
        defensive_rebounds: 2,
        assists: 4,
        steals: 1,
        blocks: 0,
        turnovers: 2,
        personal_fouls: 1,
        field_goals_made: 4,
        field_goals_attempted: 8,
        three_pointers_made: 1,
        three_pointers_attempted: 3,
        free_throws_made: 1,
        free_throws_attempted: 2,
        plus_minus: 5,
        double_double: false,
        triple_double: false,
        did_not_play: false,
        minutes_played: 12.5,
        nba_games: {
            id: `game-${id}`,
            nba_game_id: nbaGameId,
            game_date: gameDate,
            home_team: 'BOS',
            away_team: 'NYK',
        },
    })

    function setupGameLogMock(rows: any[]) {
        const rangeStub = vi.fn().mockResolvedValue({ data: rows, error: null })
        const orderStub = vi.fn().mockReturnValue({ range: rangeStub })
        const likeStub = vi.fn().mockReturnValue({ order: orderStub })
        const eqSeasonStub = vi.fn().mockReturnValue({ like: likeStub })
        const eqPlayerStub = vi.fn().mockReturnValue({ eq: eqSeasonStub })
        const selectStub = vi.fn().mockReturnValue({ eq: eqPlayerStub })
        ;(supabase.from as ReturnType<typeof vi.fn>).mockReturnValue({ select: selectStub })
        return { likeStub, rangeStub }
    }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('filters regular-season games in the query before applying range pagination', async () => {
        const queriedRows = [
            gameRow('regular-2', '0022700002', '2027-10-24'),
            gameRow('regular-3', '0022700003', '2027-10-26'),
            gameRow('regular-4', '0022700004', '2027-10-28'),
        ]
        const { likeStub, rangeStub } = setupGameLogMock(queriedRows)

        const result = await getPlayerGameLog('player-1', 'BOS', 2027, 2, 1)

        expect(likeStub).toHaveBeenCalledWith('nba_games.nba_game_id', '002%')
        expect(rangeStub).toHaveBeenCalledWith(1, 3)
        expect(result.hasMore).toBe(true)
        expect(result.games.map((game) => game.gameId)).toEqual(['regular-2', 'regular-3'])
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

    it('passes an explicit empty include scope so empty waiver/mine filters stay empty', async () => {
        ;(supabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], error: null })

        await searchPlayers('', 'ALL', [], null, null, false, 0, 'all', { includePlayerIds: [] })

        expect(supabase.rpc).toHaveBeenCalledWith('search_players', expect.objectContaining({
            p_include_player_ids: [],
        }))
    })
})

describe('Players tab jitter guards', () => {
    it('does not remount FlashList or replay row entrance animations on sort changes', () => {
        const source = read('app/(tabs)/players.tsx')
        const flashListBody = source.slice(source.indexOf('<FlashList'), source.indexOf('ListHeaderComponent'))

        expect(flashListBody).not.toMatch(/\n\s+key=\{/)
        expect(flashListBody).toContain('extraData={playerListExtraData}')
        expect(source).toContain('animate={false}')
    })

    it('keeps rookies-only search as a complete internally paged result set', () => {
        const source = read('hooks/use-player-search.ts')

        expect(source).toContain('const ROOKIE_SEARCH_MAX_PAGES')
        expect(source).toContain('if (!params.rookiesOnly || firstPage.length < PLAYER_SEARCH_PAGE_SIZE) return firstPage')
        expect(source).toContain('fetchCompleteResults(searchParams)')
        expect(source).toContain('const hasNext = !searchParams.rookiesOnly && results.length === PLAYER_SEARCH_PAGE_SIZE')
    })
})
