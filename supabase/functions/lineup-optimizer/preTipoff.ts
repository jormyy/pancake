import { supabase } from '../_shared/supabase.ts'
import { chooseBestAssignments } from './assignments.ts'
import { startLeaseHeartbeat } from '../_shared/leaseHeartbeat.ts'
import { withWorkContext } from '../_shared/workContext.ts'
import { runBounded } from '../_shared/runBounded.ts'
import { errorMessage } from '../_shared/responses.ts'

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
  const projectionMap = new Map(projections.map((row) => [row.player_id, Number(row.projection_fantasy_points ?? 0)]))
  const slots = [...context.templates]
    .sort((a, b) => slotOrder.indexOf(a.slotType) - slotOrder.indexOf(b.slotType))
    .flatMap((template) => Array.from({ length: Math.max(0,
      template.count - locked.filter((entry) => entry.slot_type === template.slotType).length,
    ) }, () => template.slotType))
  const players = tipoffPlayers(context).map((player) => ({
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

function tipoffPlayers(context: TipoffContext) {
  const lockedIds = new Set(context.stored.filter(entry => entry.locked).map(entry => entry.player_id))
  return context.players.filter(player => {
    const status = player.injuryStatus?.toLowerCase() ?? ''
    return !player.locked && !lockedIds.has(player.playerId) && player.hasGame
      && status !== 'out' && !status.startsWith('ir')
  })
}

export async function processPreTipoff(body: Record<string, unknown>) {
  if (typeof body.tipoffAt !== 'string' || typeof body.token !== 'string') {
    throw new TypeError('Tipoff and claim token are required.')
  }
  const tipoffAt = body.tipoffAt
  const token = body.token
  const { data: date, error: claimError } = await supabase.rpc('claim_lineup_tipoff_dispatch', {
    p_tipoff_at: tipoffAt, p_token: token,
  }).abortSignal(AbortSignal.timeout(5000))
  if (claimError) throw claimError
  if (!date) return { optimized: 0, failed: 0, claimed: false, errors: [] as string[] }
  const controller = new AbortController()
  const budget = Math.max(0, Math.min(110_000, Date.parse(tipoffAt) + 55_000 - Date.now()))
  const deadline = setTimeout(() => controller.abort(new Error('Tipoff optimization reached its work deadline')), budget)
  const heartbeat = startLeaseHeartbeat(async () => {
    const { data, error } = await supabase.rpc('renew_lineup_tipoff_dispatch', {
      p_tipoff_at: tipoffAt, p_token: token,
    }).abortSignal(AbortSignal.timeout(5000))
    if (error) throw error
    return data === true
  }, 15_000, error => controller.abort(error ?? new Error('Tipoff lease expired or changed')))
  let optimized = 0
  const failures: string[] = []
  const excluded: string[] = []
  try {
    await withWorkContext({ signal: controller.signal }, async () => {
      while (!controller.signal.aborted) {
        const { data: settings, error: workError } = await supabase.rpc('get_pending_tipoff_members', {
          p_tipoff_at: tipoffAt, p_token: token, p_excluded_members: excluded, p_limit: 100,
        })
        if (workError) throw workError
        if (!settings?.length) break
        await runBounded(settings.map(setting => async () => {
          if (controller.signal.aborted) return
          try {
            const { data, error } = await supabase.rpc('get_pre_tipoff_lineup_context', {
              p_league_id: setting.league_id, p_league_season_id: setting.league_season_id, p_member_id: setting.member_id,
            })
            if (error) throw error
            if (!data) throw new Error('Tipoff context is no longer available')
            const context = data as unknown as TipoffContext
            if (context.date !== date) throw new Error('Tipoff date changed during optimization')
            const playerIds = tipoffPlayers(context).map(player => player.playerId)
            const projections = playerIds.length ? await supabase.rpc('get_league_projection_rows', {
              p_league_id: setting.league_id, p_season_year: context.seasonYear, p_game_date: date,
              p_view: 'today', p_player_ids: playerIds, p_limit: playerIds.length, p_offset: 0,
            }) : { data: [], error: null }
            if (projections.error) throw projections.error
            const { data: changed, error: applyError } = await supabase.rpc('apply_pre_tipoff_lineup', {
              p_tipoff_at: tipoffAt, p_token: token, p_league_id: setting.league_id,
              p_league_season_id: setting.league_season_id, p_member_id: setting.member_id,
              p_assignments: tipoffAssignments(context, projections.data ?? []),
            })
            if (applyError) throw applyError
            if (changed) optimized++
          } catch (error) {
            excluded.push(setting.member_id)
            failures.push(`${setting.member_id}: ${errorMessage(error)}`)
          }
        }), 4)
      }
    })
  } catch (error) {
    failures.push(errorMessage(error))
  } finally {
    clearTimeout(deadline)
    heartbeat.stop()
  }
  if (controller.signal.aborted) failures.push(errorMessage(controller.signal.reason))
  const { error: finishError } = await supabase.rpc('finish_lineup_tipoff_dispatch', {
    p_tipoff_at: tipoffAt, p_token: token, ...(failures.length ? { p_error: failures.join('\n') } : {}),
  }).abortSignal(AbortSignal.timeout(5000))
  if (finishError) failures.push(errorMessage(finishError))
  return { optimized, failed: failures.length, claimed: true, errors: failures }
}
