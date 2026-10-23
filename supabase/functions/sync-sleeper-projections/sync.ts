import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from '../_shared/database.ts'
import { parseSleeperProjections } from './parser.ts'
import { matchSleeperProjections, type SleeperPlayer } from './match.ts'

export type SleeperSyncContext = { seasonYear: number; weekNumber: number; sleeperWeek: number; weekStart: string; weekEnd: string }

export async function syncSleeperProjections(client: SupabaseClient<Database>, context: SleeperSyncContext, fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const url = `https://api.sleeper.app/projections/nba/${context.seasonYear - 1}/${context.sleeperWeek}?season_type=regular`
  const { data: run, error: runError } = await client.from('projection_sync_runs').insert({
    source: 'sleeper', projection_type: 'weekly_total', source_url: url, season_year: context.seasonYear,
    week_number: context.weekNumber, parser_version: 'sleeper-rotowire-v1', status: 'running',
  }).select('id').single()
  if (runError) throw new Error(runError.message)
  let httpStatus: number | null = null
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000) })
    httpStatus = response.status
    if (!response.ok) throw new Error(`Sleeper projections HTTP ${response.status}`)
    const rows = parseSleeperProjections(await response.json(), context)
    const players: SleeperPlayer[] = []
    for (let start = 0; ; start += 1000) {
      const { data, error } = await client.from('players').select('id,sleeper_id,display_name,nba_team').order('id').range(start, start + 999)
      if (error) throw new Error(error.message)
      players.push(...data)
      if (data.length < 1000) break
    }
    const payload = matchSleeperProjections(rows, players, context.seasonYear, context.weekNumber)
    if (!payload.matched) throw new Error('No Sleeper projections match Pancake players')
    const { error } = await client.rpc('complete_sleeper_projection_sync', {
      p_run_id: run.id, p_rows: payload.rows, p_row_count: rows.length,
      p_unmatched_count: payload.unmatched, p_http_status: httpStatus,
      p_metadata: { unmatchedIds: payload.unmatchedIds, weekStart: context.weekStart, weekEnd: context.weekEnd },
    })
    if (error) throw new Error(error.message)
    return { rows: payload.matched, unmatched: payload.unmatched }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const { error: finishError } = await client.from('projection_sync_runs').update({
      status: 'failed', completed_at: new Date().toISOString(), http_status: httpStatus, error_message: message,
    }).eq('id', run.id)
    if (finishError) throw new Error(`${message}; cannot record failed Sleeper run: ${finishError.message}`)
    throw error
  }
}
