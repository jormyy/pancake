import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../_shared/database.ts'
import type { OptimizerSetting } from './settings.ts'

type ProjectionRow = Pick<Database['public']['Functions']['get_league_projection_rows']['Returns'][number],
  'player_id' | 'projection_fantasy_points' | 'projection_source' | 'projection_source_label' | 'projection_view'>
type ProjectionContext = { date: string; seasonYear: number }
const PAGE_SIZE = 1000

export function createScheduledProjectionLoader(client: SupabaseClient<Database>, settings: OptimizerSetting[]) {
  const rosters = new Map<string, Promise<string[]>>()
  const snapshots = new Map<string, Promise<Map<string, ProjectionRow>>>()

  const loadRoster = async (setting: OptimizerSetting): Promise<string[]> => {
    const ids: string[] = []
    const members = settings.filter(row => row.league_id === setting.league_id
      && row.league_season_id === setting.league_season_id).map(row => row.member_id)
    for (let memberOffset = 0; memberOffset < members.length; memberOffset += 100) {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await client.from('roster_players').select('player_id')
          .eq('league_id', setting.league_id).eq('league_season_id', setting.league_season_id)
          .in('member_id', members.slice(memberOffset, memberOffset + 100))
          .eq('is_on_ir', false).eq('is_on_taxi', false)
          .order('player_id').range(offset, offset + PAGE_SIZE - 1)
        if (error) throw error
        ids.push(...data.map(row => row.player_id))
        if (data.length < PAGE_SIZE) break
      }
    }
    return ids
  }

  const loadRows = async (setting: OptimizerSetting, context: ProjectionContext, ids: string[]) => {
    const rows: ProjectionRow[] = []
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      const chunk = ids.slice(offset, offset + PAGE_SIZE)
      const { data, error } = await client.rpc('get_league_projection_rows', {
        p_league_id: setting.league_id, p_season_year: context.seasonYear,
        p_game_date: context.date, p_view: 'today', p_player_ids: chunk,
        p_limit: chunk.length, p_offset: 0,
      }).select('player_id,projection_fantasy_points,projection_source,projection_source_label,projection_view')
      if (error) throw error
      rows.push(...data)
    }
    return rows
  }

  return async (setting: OptimizerSetting, context: ProjectionContext, playerIds: string[]): Promise<ProjectionRow[]> => {
    const rosterKey = `${setting.league_id}|${setting.league_season_id}`
    const key = `${rosterKey}|${context.seasonYear}|${context.date}`
    let snapshot = snapshots.get(key)
    if (!snapshot) {
      snapshot = (async () => {
        let roster = rosters.get(rosterKey)
        if (!roster) {
          roster = loadRoster(setting).catch(error => { rosters.delete(rosterKey); throw error })
          rosters.set(rosterKey, roster)
        }
        const ids = [...new Set([...await roster, ...playerIds])]
        return new Map((await loadRows(setting, context, ids)).map(row => [row.player_id, row]))
      })().catch(error => { snapshots.delete(key); throw error })
      snapshots.set(key, snapshot)
    }
    const rows = await snapshot
    const missing = playerIds.filter(id => !rows.has(id))
    if (missing.length) {
      for (const row of await loadRows(setting, context, missing)) rows.set(row.player_id, row)
    }
    return playerIds.flatMap(id => { const row = rows.get(id); return row ? [row] : [] })
  }
}
