import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from '../_shared/database.ts'
import { parseSleeperProjections, SleeperProjectionParseError } from './parser.ts'
import { linkPlayerSources } from '../_shared/sourceLinks.ts'
import { matchSleeperProjections, type SleeperPlayer } from './match.ts'

export type SleeperSyncContext = { seasonYear: number; weekNumber: number; sleeperWeek: number; weekStart: string; weekEnd: string }
export type ProjectionWeekRow = { week_number: number; week_start: string; week_end: string }

const mondayOf = (value: string) => {
  const day = new Date(`${value}T12:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7)
  return day.toISOString().slice(0, 10)
}

export function resolveProjectionWeek(weeks: ProjectionWeekRow[], date: string): Omit<SleeperSyncContext, 'seasonYear'> | null {
  const ordered = [...weeks].sort((a, b) => a.week_start.localeCompare(b.week_start))
  const week = ordered.find((item) => item.week_start <= date && date <= item.week_end)
  if (!week) return null
  const weekStart = mondayOf(date)
  const weekEnd = new Date(Date.parse(`${weekStart}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10)
  const sleeperWeek = Math.round((Date.parse(weekStart) - Date.parse(mondayOf(ordered[0].week_start))) / (7 * 86400000)) + 1
  return { weekNumber: week.week_number, sleeperWeek, weekStart, weekEnd }
}

export async function syncSleeperProjections(client: SupabaseClient<Database>, context: SleeperSyncContext, fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  const url = `https://api.sleeper.app/projections/nba/${context.seasonYear - 1}/${context.sleeperWeek}?season_type=regular`
  const { data: run, error: runError } = await client.from('projection_sync_runs').insert({
    source: 'sleeper', projection_type: 'weekly_total', source_url: url, season_year: context.seasonYear,
    week_number: context.weekNumber, parser_version: 'sleeper-rotowire-v2', status: 'running',
  }).select('id').single()
  if (runError) throw new Error(runError.message)
  let httpStatus: number | null = null
  let completionRecorded = false
  let parseMetadata: { inputRowCount: number; rejectedRowCount: number } | undefined
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000) })
    httpStatus = response.status
    if (!response.ok) throw new Error(`Sleeper projections HTTP ${response.status}`)
    const parsed = parseSleeperProjections(await response.json(), context)
    const { rows, sourceKeys, inputRowCount, rejectedRowCount } = parsed
    parseMetadata = { inputRowCount, rejectedRowCount }
    const players: SleeperPlayer[] = []
    for (let start = 0; ; start += 1000) {
      const { data, error } = await client.from('players').select('id,sleeper_id,display_name,nba_team').order('id').range(start, start + 999)
      if (error) throw new Error(error.message)
      players.push(...data)
      if (data.length < 1000) break
    }
    if (players.some(player => !player.sleeper_id && player.display_name && player.nba_team)) {
      const known = new Set(players.flatMap(player => player.sleeper_id ? [player.sleeper_id] : []))
      const sources = [...new Map(rows.filter(row => !known.has(row.player_id)).map(row => [row.player_id, {
        provider_id: row.player_id, display_name: `${row.player.first_name} ${row.player.last_name}`, nba_team: row.team,
        ...(row.player.position ? { position: row.player.position } : {}),
        ...(row.player.years_exp != null ? { years_exp: row.player.years_exp } : {}),
      }])).values()]
      const linked = await linkPlayerSources(client, 'sleeper', sources)
      for (const result of linked) {
        const player = players.find(player => player.id === result.player_id)
        if (player && ['updated', 'unchanged'].includes(result.action)) player.sleeper_id = sources[result.index].provider_id
      }
    }
    const payload = matchSleeperProjections(rows, players, context.seasonYear, context.weekNumber)
    if (!payload.matched) throw new Error('No Sleeper projections match Pancake players')
    const { error } = await client.rpc('complete_sleeper_projection_sync', {
      p_run_id: run.id, p_rows: payload.rows, p_row_count: rows.length,
      p_unmatched_count: payload.unmatched, p_http_status: httpStatus,
      p_metadata: { ...parseMetadata, seenSourceKeys: sourceKeys, unmatchedIds: payload.unmatchedIds, weekStart: context.weekStart, weekEnd: context.weekEnd },
    })
    if (error) throw new Error(error.message)
    completionRecorded = true
    const { data: completion, error: completionError } = await client.from('projection_sync_runs')
      .select('status,error_message').eq('id', run.id).single()
    if (completionError) throw new Error(completionError.message)
    if (completion.status === 'failed') throw new Error(completion.error_message ?? 'Sleeper projection completion failed')
    return { rows: payload.matched, unmatched: payload.unmatched, rejected: rejectedRowCount }
  } catch (error) {
    if (completionRecorded) throw error
    if (error instanceof SleeperProjectionParseError) parseMetadata = { inputRowCount: error.inputRowCount, rejectedRowCount: error.rejectedRowCount }
    const message = error instanceof Error ? error.message : String(error)
    const { error: finishError } = await client.from('projection_sync_runs').update({
      status: 'failed', completed_at: new Date().toISOString(), http_status: httpStatus, error_message: message,
      source_metadata: { ...parseMetadata, weekStart: context.weekStart, weekEnd: context.weekEnd },
    }).eq('id', run.id)
    if (finishError) throw new Error(`${message}; cannot record failed Sleeper run: ${finishError.message}`)
    throw error
  }
}
