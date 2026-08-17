import { supabase } from '@/lib/supabase'
import type { Database, Json } from '@/types/database'
import type {
    DynastyEngineContext,
    DynastyPlayerAsset,
    DynastyStrategy,
} from '@pancake/core'

export type DynastyDecisionInput = Database['public']['Functions']['get_dynasty_decision_inputs']['Returns'][number]

export type DynastyDecisionCacheScope = {
    userId: string
    memberId: string
    leagueId: string
    seasonYear: number
    strategy: DynastyStrategy
    query: string
}

export const DYNASTY_DECISION_CACHE_PREFIX = 'pancake:dynasty-decisions:v2:'
export const DYNASTY_ANALYZER_CACHE_PREFIX = 'pancake:dynasty-analyzer-snapshot:v1:'

const normalizedQuery = (query: string) => encodeURIComponent(query.trim().toLocaleLowerCase())

export function dynastyDecisionCacheKey(scope: DynastyDecisionCacheScope): string {
    return `${DYNASTY_DECISION_CACHE_PREFIX}${scope.userId}:${scope.memberId}:${scope.leagueId}:${scope.seasonYear}:${scope.strategy}:${normalizedQuery(scope.query)}`
}

export function dynastyAnalyzerSnapshotCacheKey(
    userId: string,
    memberId: string,
    leagueId: string,
): string {
    return `${DYNASTY_ANALYZER_CACHE_PREFIX}${userId}:${memberId}:${leagueId}`
}

export function scoringSettingsFromJson(value: Json | null | undefined): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
        typeof entry === 'number' && Number.isFinite(entry) ? [[key, entry]] : [],
    ))
}

export function dynastyEngineContext(
    leagueId: string,
    seasonYear: number,
    scoringSettings: Json | null | undefined,
    replacementValue = 180,
): DynastyEngineContext {
    return {
        leagueId,
        seasonYear,
        scoringSettings: scoringSettingsFromJson(scoringSettings),
        replacementValue,
    }
}

export function playerAssetFromDecisionInput(row: DynastyDecisionInput): DynastyPlayerAsset {
    const sources = [
        row.ranking_source ? { name: row.ranking_source, fetchedAt: row.ranking_fetched_at } : null,
        row.projection_source ? { name: row.projection_source, fetchedAt: row.projection_fetched_at } : null,
        row.avg_fantasy_points != null ? { name: 'league season averages', fetchedAt: null } : null,
    ].filter((source): source is NonNullable<typeof source> => source != null)
    return {
        kind: 'player',
        id: row.player_id,
        label: row.display_name,
        age: row.age,
        dynastyRank: row.dynasty_rank,
        rankMovement: row.rank_change,
        healthStatus: row.injury_status,
        productionFantasyPoints: row.avg_fantasy_points,
        projectionFantasyPoints: row.projection_fantasy_points,
        isRookie: row.years_exp === 0,
        sources,
    }
}

export async function getDynastyDecisionInputs({
    leagueId,
    memberId,
    seasonYear,
    playerIds,
    query = '',
    limit = 600,
    offset = 0,
}: {
    leagueId: string
    memberId: string
    seasonYear: number
    playerIds?: string[]
    query?: string
    limit?: number
    offset?: number
}): Promise<DynastyDecisionInput[]> {
    const { data, error } = await supabase.rpc('get_dynasty_decision_inputs', {
        p_league_id: leagueId,
        p_member_id: memberId,
        p_season_year: seasonYear,
        p_player_ids: playerIds,
        p_query: query,
        p_limit: Math.min(Math.max(Math.trunc(limit), 1), 1000),
        p_offset: Math.max(Math.trunc(offset), 0),
    })
    if (error) throw error
    return data ?? []
}
