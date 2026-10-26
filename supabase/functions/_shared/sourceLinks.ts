import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from './database.ts'
import { errorMessage } from './responses.ts'

export type SourceLinkRecord = {
  provider_id: string; display_name: string; nba_team: string
  years_exp?: number | null; position?: string | null; espn_id?: string; nba_id?: string; sleeper_id?: string
}

export async function linkPlayerSources(client: Pick<SupabaseClient<Database>, 'rpc'>, source: 'espn' | 'nba' | 'sleeper', records: SourceLinkRecord[], currentRoster = false) {
  const results: { index: number; player_id: string | null; action: string }[] = []
  for (let offset = 0; offset < records.length; offset += 500) {
    const batch = records.slice(offset, offset + 500)
    const { data, error } = await client.rpc('link_player_sources_atomic', {
      p_source: source, p_records: batch, p_current_roster: currentRoster,
    })
    if (error) throw new Error(`Link ${source} players: ${errorMessage(error)}`)
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.results)
      || data.results.length !== batch.length) throw new Error(`Invalid ${source} source-link receipt`)
    for (const [index, row] of data.results.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.index !== index
        || typeof row.action !== 'string' || !['inserted', 'updated', 'unchanged', 'missing', 'ambiguous'].includes(row.action)
        || (row.player_id !== null && typeof row.player_id !== 'string')
        || (['inserted', 'updated', 'unchanged'].includes(row.action) && !row.player_id)) throw new Error(`Invalid ${source} source-link result`)
      results.push({ index: offset + index, player_id: row.player_id, action: row.action })
    }
  }
  return results
}
