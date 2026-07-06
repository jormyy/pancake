import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import type { Database } from '@/types/database'

export const DYNASTY_RANKINGS_PAGE_SIZE = 50

export type DynastyRankPlayer = {
    rankingId: string
    playerId: string | null
    displayName: string
    sourceName: string
    sourceTeam: string | null
    sourcePositions: string[]
    nbaTeam: string | null
    position: string | null
    eligiblePositions: string[]
    injuryStatus: string | null
    yearsExp: number | null
    headshotUrl: string | null
    nbaId: string | null
    dynastyRank: number
    rankChange: number
    age: number | null
    gamesPlayed: number | null
    fieldGoalPct: number | null
    freeThrowPct: number | null
    threePointersMade: number | null
    points: number | null
    rebounds: number | null
    assists: number | null
    steals: number | null
    blocks: number | null
    turnovers: number | null
    comment: string | null
    rankSource: string
    scoringFormat: string
    sourceUrl: string | null
    sourceMetadata: Database['public']['Tables']['dynasty_rankings']['Row']['source_metadata']
    rankFetchedAt: string
    isDraftPick: boolean
}

/** Source rows like "2026 Draft (Pick 1)" are ranked placeholders, not players. */
function isDraftPickRow(name: string, team: string | null): boolean {
    return team?.toUpperCase() === 'DRA' || /^\d{4}\s+draft\s+\(/i.test(name)
}

export type DynastyRankingsPage = {
    players: DynastyRankPlayer[]
    hasMore: boolean
}

export type DynastyNewsItem = {
    id: string
    title: string
    summary: string
    source: string
    url: string | null
    publishedAt: string
    playerName: string | null
    playerTeam: string | null
    playerNbaId: string | null
}

type RankingPlayerJoin = {
    id: string
    display_name: string | null
    nba_team: string | null
    position: string | null
    eligible_positions: string[] | null
    injury_status: string | null
    years_exp: number | null
    headshot_url: string | null
    nba_id: string | null
}
type DynastyRankingRow = Pick<
    Database['public']['Tables']['dynasty_rankings']['Row'],
    | 'id'
    | 'source'
    | 'scoring_format'
    | 'source_url'
    | 'source_metadata'
    | 'source_rank'
    | 'source_player_name'
    | 'source_team'
    | 'source_positions'
    | 'age'
    | 'rank_change'
    | 'games_played'
    | 'field_goal_pct'
    | 'free_throw_pct'
    | 'three_pointers_made'
    | 'points'
    | 'rebounds'
    | 'assists'
    | 'steals'
    | 'blocks'
    | 'turnovers'
    | 'comment'
    | 'fetched_at'
> & { player: RankingPlayerJoin | null }

export async function getDynastyRankingsPage({
    query = '',
    limit = DYNASTY_RANKINGS_PAGE_SIZE,
    offset = 0,
}: {
    query?: string
    limit?: number
    offset?: number
} = {}): Promise<DynastyRankingsPage> {
    const trimmedQuery = query.trim()
    let request = supabase
        .from('dynasty_rankings')
        .select(
            'id, source, scoring_format, source_url, source_metadata, source_rank, source_player_name, source_team, source_positions, age, rank_change, games_played, field_goal_pct, free_throw_pct, three_pointers_made, points, rebounds, assists, steals, blocks, turnovers, comment, fetched_at, player:players!dynasty_rankings_player_id_fkey(id, display_name, nba_team, position, eligible_positions, injury_status, years_exp, headshot_url, nba_id)',
        )
        .eq('source', 'hashtagbasketball.com')
        .order('source_rank', { ascending: true })
        .range(offset, offset + limit)

    if (trimmedQuery) {
        request = request.ilike('source_player_name', `%${trimmedQuery}%`)
    }

    const { data, error } = await request.returns<DynastyRankingRow[]>()

    if (error) throw error

    const rows = data ?? []
    return {
        hasMore: rows.length > limit,
        players: rows.slice(0, limit).map((row) => {
            const player = row.player
            return {
                rankingId: row.id,
                playerId: player?.id ?? null,
                displayName: player?.display_name ?? row.source_player_name,
                sourceName: row.source_player_name,
                sourceTeam: row.source_team,
                sourcePositions: row.source_positions ?? [],
                nbaTeam: player?.nba_team ?? null,
                position: player?.position ?? null,
                eligiblePositions: player?.eligible_positions ?? [],
                injuryStatus: player?.injury_status ?? null,
                yearsExp: player?.years_exp ?? null,
                headshotUrl: player?.headshot_url ?? null,
                nbaId: player?.nba_id ?? null,
                dynastyRank: row.source_rank,
                rankChange: row.rank_change,
                age: row.age,
                gamesPlayed: row.games_played,
                fieldGoalPct: row.field_goal_pct,
                freeThrowPct: row.free_throw_pct,
                threePointersMade: row.three_pointers_made,
                points: row.points,
                rebounds: row.rebounds,
                assists: row.assists,
                steals: row.steals,
                blocks: row.blocks,
                turnovers: row.turnovers,
                comment: row.comment,
                rankSource: row.source,
                scoringFormat: row.scoring_format,
                sourceUrl: row.source_url,
                sourceMetadata: row.source_metadata,
                rankFetchedAt: row.fetched_at,
                isDraftPick: isDraftPickRow(row.source_player_name, row.source_team),
            }
        }),
    }
}

export async function getDynastyNews(limit = 20): Promise<DynastyNewsItem[]> {
    return fetchDynastyNews(limit)
}

export async function getMyDynastyNews(memberId: string, leagueId: string, limit = 20): Promise<DynastyNewsItem[]> {
    const seasonId = await getActiveSeasonId(leagueId)
    if (!seasonId) return []

    const { data: rosterRows, error: rosterError } = await supabase
        .from('roster_players')
        .select('player_id')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonId)

    if (rosterError) throw rosterError

    const playerIds = Array.from(new Set((rosterRows ?? [])
        .map((row) => row.player_id)
        .filter((playerId): playerId is string => Boolean(playerId))))
    if (playerIds.length === 0) return []

    return fetchDynastyNews(limit, playerIds)
}

async function fetchDynastyNews(limit: number, playerIds?: string[]): Promise<DynastyNewsItem[]> {
    let request = supabase
        .from('dynasty_news')
        .select('id, title, summary, source, url, published_at, player_id, players(display_name, nba_team, nba_id)')
        .order('published_at', { ascending: false })
        .limit(limit)

    if (playerIds) request = request.in('player_id', playerIds)

    const { data, error } = await request

    if (error) {
        if (error.code === 'PGRST205') return []
        throw error
    }

    return (data ?? []).map((row) => {
        const player = row.players as { display_name: string | null; nba_team: string | null; nba_id: string | null } | null
        return {
            id: row.id,
            title: row.title,
            summary: row.summary,
            source: row.source,
            url: row.url,
            publishedAt: row.published_at,
            playerName: player?.display_name ?? null,
            playerTeam: player?.nba_team ?? null,
            playerNbaId: player?.nba_id ?? null,
        }
    })
}
