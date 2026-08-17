import { supabase } from '@/lib/supabase'
import { getActiveSeasonId } from '@/lib/shared/season'
import type { Database } from '@/types/database'
import type { DynastyAssetResult, DynastyStrategy, DynastyValueRange } from '@pancake/core'

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
    isRookie?: boolean
    strategyValues?: Record<DynastyStrategy, number>
    selectedValue?: number
    valueRange?: DynastyValueRange | null
    shortTermPoints?: number
    projectionPoints?: number
    longTermValue?: number
    confidence?: number
    decisionSources?: DynastyAssetResult['sources']
    missingInputs?: string[]
    assumptions?: string[]
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
