import { supabase } from '@/lib/supabase'
export { currentSeasonYear } from '@pancake/core'

type SeasonInfo = { id: string; seasonYear: number } | null

// Nearly every data helper (roster, waivers, lineups, scoring, availability)
// resolves the league's current season first, so one screen load used to issue
// the same league_seasons query four or five times. A short-TTL promise cache
// collapses those into one round trip while staying fresh enough that a season
// rollover is picked up within seconds.
const SEASON_CACHE_TTL_MS = 15_000
const currentSeasonCache = new Map<string, { at: number; promise: Promise<SeasonInfo> }>()
const latestSeasonCache = new Map<string, { at: number; promise: Promise<string | null> }>()

function cached<T>(
    cache: Map<string, { at: number; promise: Promise<T> }>,
    key: string,
    fetcher: () => Promise<T>,
): Promise<T> {
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && now - hit.at < SEASON_CACHE_TTL_MS) return hit.promise
    const promise = fetcher()
    cache.set(key, { at: now, promise })
    promise.catch(() => {
        if (cache.get(key)?.promise === promise) cache.delete(key)
    })
    return promise
}

/** Drops cached season lookups (e.g. after commissioner season actions). */
export function invalidateSeasonCache(leagueId?: string) {
    if (leagueId) {
        currentSeasonCache.delete(leagueId)
        latestSeasonCache.delete(leagueId)
    } else {
        currentSeasonCache.clear()
        latestSeasonCache.clear()
    }
}

/**
 * Fetches the current league season (id + season_year).
 */
export function getCurrentSeason(leagueId: string): Promise<SeasonInfo> {
    return cached(currentSeasonCache, leagueId, async () => {
        const { data, error } = await supabase
            .from('league_seasons')
            .select('id, season_year')
            .eq('league_id', leagueId)
            .eq('is_current', true)
            .maybeSingle()
        if (error) throw error
        return data ? { id: data.id, seasonYear: data.season_year } : null
    })
}

/**
 * Convenience wrapper — returns just the season id or null.
 */
export async function getCurrentSeasonId(leagueId: string): Promise<string | null> {
    const season = await getCurrentSeason(leagueId)
    return season?.id ?? null
}

export function getLatestSeasonId(leagueId: string): Promise<string | null> {
    return cached(latestSeasonCache, leagueId, async () => {
        const { data, error } = await supabase
            .from('league_seasons')
            .select('id')
            .eq('league_id', leagueId)
            .order('season_year', { ascending: false })
            .limit(1)
            .maybeSingle()
        if (error) throw error
        return data?.id ?? null
    })
}

/**
 * Like getCurrentSeasonId but falls back to the most recent season when
 * no season is marked is_current (e.g. during the offseason).
 */
export async function getActiveSeasonId(leagueId: string): Promise<string | null> {
    const current = await getCurrentSeasonId(leagueId)
    if (current) return current
    return getLatestSeasonId(leagueId)
}
