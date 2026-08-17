import { supabase } from '@/lib/supabase'
import type { Database, Json } from '@/types/database'
import type {
    DynastyEngineContext,
    DynastyPlayerAsset,
} from '@pancake/core'
import type { MultiTeamTradeItemPayload } from '@/lib/trades'

export type DynastyDecisionInput = Database['public']['Functions']['get_dynasty_forecast_inputs']['Returns'][number]
export type UnmatchedRookieRanking = Pick<
    Database['public']['Tables']['dynasty_rankings']['Row'],
    'id' | 'source_rank' | 'source_player_name' | 'source_team' | 'source_positions' | 'age' | 'fetched_at'
>

export type DynastyDecisionCacheScope = {
    userId: string
    memberId: string
    leagueId: string
    seasonYear: number
    scoringSignature: string
}

export type DynastyAnalyzerCacheScope = {
    userId: string
    memberId: string
    leagueId: string
    seasonYear: number
    scoringSignature: string
    teams: number
    faabBudget: number
}

export type DynastyAnalyzerCacheIdentity = Pick<
    DynastyAnalyzerCacheScope,
    'userId' | 'memberId' | 'leagueId'
>

const DYNASTY_DECISION_CACHE_PREFIX = 'pancake:dynasty-forecast-snapshot:v1:'
const DYNASTY_DECISION_LATEST_PREFIX = 'pancake:dynasty-forecast-latest:v1:'
const DYNASTY_ANALYZER_CACHE_PREFIX = 'pancake:dynasty-analyzer-snapshot:v4:'
const DYNASTY_ANALYZER_LATEST_PREFIX = 'pancake:dynasty-analyzer-latest:v3:'
const DYNASTY_ANALYZER_SCOPE_PREFIX = 'pancake:dynasty-analyzer-scope:v1:'

export function dynastyDecisionCacheKey(scope: DynastyDecisionCacheScope): string {
    return `${DYNASTY_DECISION_CACHE_PREFIX}${scope.userId}:${scope.memberId}:${scope.leagueId}:${scope.seasonYear}:${encodeURIComponent(scope.scoringSignature)}`
}

export function dynastyDecisionLatestCacheKey(
    scope: Omit<DynastyDecisionCacheScope, 'seasonYear'>,
): string {
    return `${DYNASTY_DECISION_LATEST_PREFIX}${scope.userId}:${scope.memberId}:${scope.leagueId}:${encodeURIComponent(scope.scoringSignature)}`
}

export function dynastyAnalyzerRouteSignature(items: MultiTeamTradeItemPayload[]): string {
    return items.map((item) => {
        const asset = item.kind === 'player' ? item.playerId
            : item.kind === 'pick' ? item.pickId
                : String(item.faabAmount)
        return `${item.fromMemberId}>${item.toMemberId}:${item.kind}:${asset}`
    }).sort().join('|')
}

export function dynastyAnalyzerSnapshotCacheKey(
    scope: DynastyAnalyzerCacheScope,
    routeSignature: string,
): string {
    return `${DYNASTY_ANALYZER_CACHE_PREFIX}${scope.userId}:${scope.memberId}:${scope.leagueId}:${scope.seasonYear}:${encodeURIComponent(scope.scoringSignature)}:${scope.teams}:${scope.faabBudget}:${encodeURIComponent(routeSignature)}`
}

export function dynastyAnalyzerLatestRouteCacheKey(
    scope: DynastyAnalyzerCacheScope,
): string {
    return `${DYNASTY_ANALYZER_LATEST_PREFIX}${scope.userId}:${scope.memberId}:${scope.leagueId}:${scope.seasonYear}:${encodeURIComponent(scope.scoringSignature)}:${scope.teams}:${scope.faabBudget}`
}

export function dynastyAnalyzerLatestScopeCacheKey(
    identity: DynastyAnalyzerCacheIdentity,
): string {
    return `${DYNASTY_ANALYZER_SCOPE_PREFIX}${identity.userId}:${identity.memberId}:${identity.leagueId}`
}

export function scoringSettingsFromJson(value: Json | null | undefined): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
        typeof entry === 'number' && Number.isFinite(entry) ? [[key, entry]] : [],
    ))
}

export function dynastyScoringSignature(value: Json | null | undefined): string {
    return JSON.stringify(Object.entries(scoringSettingsFromJson(value)).sort(([left], [right]) =>
        left.localeCompare(right),
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
        dynastyRank: row.five_year_rank,
        rankMovement: row.rank_change,
        healthStatus: row.injury_status,
        productionFantasyPoints: row.avg_fantasy_points,
        projectionFantasyPoints: row.projection_fantasy_points,
        isRookie: row.years_exp === 0,
        sources,
    }
}

export async function getUnmatchedRookieRankings(): Promise<UnmatchedRookieRanking[]> {
    const { data, error } = await supabase
        .from('dynasty_rankings')
        .select('id, source_rank, source_player_name, source_team, source_positions, age, fetched_at')
        .eq('source', 'hashtagbasketball.com/rookie')
        .is('player_id', null)
        .order('source_rank', { ascending: true })
        .limit(100)
    if (error) throw error
    return data ?? []
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
    const { data, error } = await supabase.rpc('get_dynasty_forecast_inputs', {
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
