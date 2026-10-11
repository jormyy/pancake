import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../_shared/database.ts'

export type OptimizerSetting = {
  league_id: string
  league_season_id: string
  member_id: string
}

type ScheduledSetting = OptimizerSetting & { last_optimized_at: string | null }
const PAGE_SIZE = 1000

export async function loadEnabledOptimizerSettings(
  client: SupabaseClient<Database>, seasonYears: number[],
): Promise<OptimizerSetting[]> {
  if (seasonYears.length === 0) return []
  const settings: ScheduledSetting[] = []
  let cursor: OptimizerSetting | undefined
  while (true) {
    let query = client.from('lineup_optimizer_settings')
      .select('league_id, league_season_id, member_id, last_optimized_at, season:league_seasons!lineup_optimizer_settings_season_league_fkey!inner(season_year, is_current), league:leagues!lineup_optimizer_settings_league_id_fkey!inner(status)')
      .eq('enabled', true)
      .eq('season.is_current', true)
      .in('season.season_year', seasonYears)
      .in('league.status', ['active', 'playoffs'])
      .order('league_id').order('league_season_id').order('member_id')
      .limit(PAGE_SIZE)
    if (cursor) {
      query = query.or(`league_id.gt.${cursor.league_id},and(league_id.eq.${cursor.league_id},league_season_id.gt.${cursor.league_season_id}),and(league_id.eq.${cursor.league_id},league_season_id.eq.${cursor.league_season_id},member_id.gt.${cursor.member_id})`)
    }
    const { data, error } = await query
    if (error) throw error
    const page = data ?? []
    settings.push(...page)
    if (page.length < PAGE_SIZE) break
    cursor = page[page.length - 1]
  }
  // Read all stable-key pages before writes can reorder the work. Preserve
  // least-recently-attempted fairness when the platform stops a partial run.
  settings.sort((a, b) => {
    if (a.last_optimized_at === b.last_optimized_at) return 0
    if (a.last_optimized_at === null) return -1
    if (b.last_optimized_at === null) return 1
    return Date.parse(a.last_optimized_at) - Date.parse(b.last_optimized_at)
  })
  return settings
}
