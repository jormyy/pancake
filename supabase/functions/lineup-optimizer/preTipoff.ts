import { supabase } from '../_shared/supabase.ts'
import { chooseBestAssignments } from './assignments.ts'
import { loadEnabledOptimizerSettings } from './settings.ts'

export type TipoffContext = {
  date: string
  seasonYear: number
  weekNumber: number | null
  players: {
    playerId: string
    eligiblePositions: string[]
    injuryStatus: string | null
    locked: boolean
    hasGame: boolean
  }[]
  templates: { slotType: string; count: number }[]
  stored: {
    player_id: string
    slot_type: string
    is_auto_set: boolean
    week_number: number
    locked: boolean
  }[]
}

type Projection = { player_id: string; projection_fantasy_points: number | null }
const slotOrder = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']

export function tipoffAssignments(context: TipoffContext, projections: Projection[]) {
  const weekNumber = context.weekNumber
  if (weekNumber === null) throw new Error('Season week is missing for the tipoff date.')
  const locked = context.stored.filter((entry) => entry.locked)
  const lockedIds = new Set(locked.map((entry) => entry.player_id))
  const projectionMap = new Map(projections.map((row) => [row.player_id, Number(row.projection_fantasy_points ?? 0)]))
  const slots = [...context.templates]
    .sort((a, b) => slotOrder.indexOf(a.slotType) - slotOrder.indexOf(b.slotType))
    .flatMap((template) => Array.from({ length: Math.max(0,
      template.count - locked.filter((entry) => entry.slot_type === template.slotType).length,
    ) }, () => template.slotType))
  const players = context.players.filter((player) => {
    const status = player.injuryStatus?.toLowerCase() ?? ''
    return !player.locked && !lockedIds.has(player.playerId) && player.hasGame
      && status !== 'out' && !status.startsWith('ir')
  }).map((player) => ({
    ...player,
    projected: projectionMap.get(player.playerId) ?? 0,
    avoidInLineup: false,
  })).sort((a, b) => b.projected - a.projected || a.playerId.localeCompare(b.playerId))
  return [
    ...locked.map((entry) => ({
      player_id: entry.player_id, slot_type: entry.slot_type,
      is_auto_set: entry.is_auto_set, week_number: entry.week_number,
    })),
    ...chooseBestAssignments(slots, players, () => true, 'projection').map((entry) => ({
      player_id: entry.playerId, slot_type: entry.slotType,
      is_auto_set: true, week_number: weekNumber,
    })),
  ]
}

export async function processPreTipoff(body: Record<string, unknown>) {
  if (typeof body.tipoffAt !== 'string' || typeof body.token !== 'string') {
    throw new TypeError('Tipoff and claim token are required.')
  }
  const tipoffAt = body.tipoffAt
  const token = body.token
  const { data: date, error: claimError } = await supabase.rpc('claim_lineup_tipoff_dispatch', {
    p_tipoff_at: tipoffAt, p_token: token,
  })
  if (claimError) throw claimError
  if (!date) return { optimized: 0, failed: 0, claimed: false }
  let optimized = 0
  const failures: string[] = []
  try {
    const { data: games, error: gamesError } = await supabase.from('nba_games')
      .select('season_year').eq('game_date', date).eq('game_time', tipoffAt)
    if (gamesError) throw gamesError
    const settings = await loadEnabledOptimizerSettings(supabase, [...new Set((games ?? []).map((game) => game.season_year))])
    for (const setting of settings) {
      try {
        const { data, error } = await supabase.rpc('get_pre_tipoff_lineup_context', {
          p_league_id: setting.league_id, p_league_season_id: setting.league_season_id, p_member_id: setting.member_id,
        })
        if (error) throw error
        if (!data) continue
        const context = data as unknown as TipoffContext
        const playerIds = context.players.map((player) => player.playerId)
        const { data: projections, error: projectionError } = await supabase.rpc('get_league_projection_rows', {
          p_league_id: setting.league_id, p_season_year: context.seasonYear, p_game_date: date,
          p_view: 'today', p_player_ids: playerIds, p_limit: Math.max(1, playerIds.length), p_offset: 0,
        })
        if (projectionError) throw projectionError
        const { data: changed, error: applyError } = await supabase.rpc('apply_pre_tipoff_lineup', {
          p_tipoff_at: tipoffAt, p_token: token, p_league_id: setting.league_id,
          p_league_season_id: setting.league_season_id, p_member_id: setting.member_id,
          p_assignments: tipoffAssignments(context, projections ?? []),
        })
        if (applyError) throw applyError
        if (changed) optimized++
      } catch (error) {
        failures.push(`${setting.member_id}: ${error instanceof Error ? error.message : JSON.stringify(error)}`)
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : JSON.stringify(error))
  }
  const { error: finishError } = await supabase.rpc('finish_lineup_tipoff_dispatch', {
    p_tipoff_at: tipoffAt, p_token: token, ...(failures.length ? { p_error: failures.join('\n') } : {}),
  })
  if (finishError) throw finishError
  return { optimized, failed: failures.length, claimed: true }
}
