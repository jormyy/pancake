import type { supabase } from '../_shared/supabase.ts'
import { currentSeasonYear } from '../_shared/season.ts'

const MIN_SEASON_YEAR = 1946
const MAX_SEASON_YEAR = 2100

export const SEASON_YEAR_ERROR = `seasonYear must be an integer from ${MIN_SEASON_YEAR} to ${MAX_SEASON_YEAR}`

type Client = Pick<typeof supabase, 'from' | 'rpc'>

/** Omitted means the current season; anything else must be a whole supported year, never NaN. */
export function parseSeasonYear(value: unknown): number | null {
  if (value == null || value === '') return currentSeasonYear()
  const year = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isInteger(year) && year >= MIN_SEASON_YEAR && year <= MAX_SEASON_YEAR ? year : null
}

async function exactCount(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await query
  if (error) throw error
  return count
}

export async function validateDatabase(db: Client, seasonYear: number) {
  const totalGames = await exactCount(db
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear))

  const finalGames = await exactCount(db
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)
    .eq('status', 'Final'))

  // Use a raw SQL count to avoid PostgREST's 1000-row default limit
  const { data: missingStatsRow, error: missingStatsError } = await db
    .rpc('count_final_games_missing_stats', { season_year_param: seasonYear })
  if (missingStatsError) throw missingStatsError
  const gamesWithStats = missingStatsRow ?? 0

  const missingNbaGameId = await exactCount(db
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)
    .is('nba_game_id', null))

  const playersWithoutNbaId = await exactCount(db
    .from('players')
    .select('id', { count: 'exact', head: true })
    .is('nba_id', null))

  return {
    seasonYear,
    totalGames,
    finalGames,
    finalGamesWithoutStats: Number(gamesWithStats),
    gamesMissingNbaGameId: missingNbaGameId,
    playersWithoutNbaId,
  }
}
