import { supabase } from '@/lib/supabase'

export type DynastyRankPlayer = {
    id: string
    displayName: string
    nbaTeam: string | null
    position: string | null
    eligiblePositions: string[]
    injuryStatus: string | null
    yearsExp: number | null
    dynastyRank: number
    rankSource: string | null
    rankFetchedAt: string | null
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
}

export async function getDynastyRankings(limit = 100): Promise<DynastyRankPlayer[]> {
    const { data, error } = await supabase
        .from('players')
        .select('id, display_name, nba_team, position, eligible_positions, injury_status, years_exp, dynasty_rank, dynasty_rank_source, dynasty_rank_fetched_at')
        .not('dynasty_rank', 'is', null)
        .order('dynasty_rank', { ascending: true })
        .limit(limit)

    if (error) throw error

    return (data ?? []).map((row) => ({
        id: row.id,
        displayName: row.display_name ?? 'Unknown Player',
        nbaTeam: row.nba_team,
        position: row.position,
        eligiblePositions: row.eligible_positions ?? [],
        injuryStatus: row.injury_status,
        yearsExp: row.years_exp,
        dynastyRank: row.dynasty_rank ?? 0,
        rankSource: row.dynasty_rank_source,
        rankFetchedAt: row.dynasty_rank_fetched_at,
    }))
}

export async function getDynastyNews(limit = 20): Promise<DynastyNewsItem[]> {
    const { data, error } = await supabase
        .from('dynasty_news')
        .select('id, title, summary, source, url, published_at, players(display_name, nba_team)')
        .order('published_at', { ascending: false })
        .limit(limit)

    if (error) {
        if (error.code === 'PGRST205') return []
        throw error
    }

    return (data ?? []).map((row) => {
        const player = row.players as { display_name: string | null; nba_team: string | null } | null
        return {
            id: row.id,
            title: row.title,
            summary: row.summary,
            source: row.source,
            url: row.url,
            publishedAt: row.published_at,
            playerName: player?.display_name ?? null,
            playerTeam: player?.nba_team ?? null,
        }
    })
}
