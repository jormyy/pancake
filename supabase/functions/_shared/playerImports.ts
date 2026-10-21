import { supabase } from './supabase.ts'
import { errorMessage } from './responses.ts'
import type { Json } from './database.ts'

type PlayerImportSource = 'espn' | 'sleeper' | 'nba_cdn' | 'nba_index' | 'nba_draft'
type PlayerImportResult = { index: number; player_id: string | null; action: string }

export async function resolvePlayerImports(source: PlayerImportSource, records: Json[]) {
  const args = { p_source: source, p_records: records }
  let response = await supabase.rpc('resolve_player_imports_atomic', args)
  for (let retry = 0; retry < 3 && response.error && ['40P01', '40001'].includes(response.error.code); retry++) {
    console.warn(`[player-imports] ${source}: retry ${response.error.code} ${retry + 1}/3`)
    await new Promise(resolve => setTimeout(resolve, 50 * 2 ** retry))
    response = await supabase.rpc('resolve_player_imports_atomic', args)
  }
  const { data, error } = response
  if (error) throw new Error(`Resolve ${source} players: ${errorMessage(error)}`)
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Array.isArray(data.results) || data.results.length !== records.length
    || typeof data.stale_draft_numbers_cleared !== 'number') {
    throw new Error(`Invalid ${source} player import receipt`)
  }
  const results: PlayerImportResult[] = data.results.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.index !== index
      || typeof row.action !== 'string'
      || !['inserted', 'updated', 'ambiguous', 'missing', 'stale'].includes(row.action)
      || (row.player_id !== null && typeof row.player_id !== 'string')
      || (['inserted', 'updated'].includes(row.action) && !row.player_id)) {
      throw new Error(`Invalid ${source} player result at ${index}`)
    }
    return { index, player_id: row.player_id, action: row.action }
  })
  return { results, staleDraftNumbersCleared: data.stale_draft_numbers_cleared }
}
