import { supabase } from '../_shared/supabase.ts'
import { toETDate } from '../_shared/date.ts'
import { renewCurrentWorkLease } from '../_shared/workContext.ts'
import { errorMessage } from '../_shared/responses.ts'
import { isTransientError } from '../_shared/transientError.ts'
import { loadEnabledOptimizerSettings, loadPendingAutoIrMembers } from './settings.ts'
import { tipoffAssignments, type TipoffContext } from './preTipoff.ts'
import { manageIrForMember, manageIrForMemberStrict } from './ir.ts'

export async function processDaily(body: Record<string, unknown>) {
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new TypeError('Daily optimization requires an Eastern calendar date.')
  }
  const date = body.date
  const result = { optimized: 0, failed: 0, errors: [] as string[] }
  if (date !== toETDate(new Date())) return result
  const { data: games, error: gameError } = await supabase.from('nba_games')
    .select('season_year').eq('game_date', date).eq('status', 'Scheduled')
  if (gameError) throw gameError
  const autoIr = await loadPendingAutoIrMembers(supabase, date, { limit: 1000, includeEnabled: true })
  const strict = new Set(autoIr.map(member => `${member.league_id}:${member.league_season_id}:${member.member_id}`))
  const enabledLeagues = new Set(autoIr.map(member => `${member.league_id}:${member.league_season_id}`))
  const failed = new Set<string>()
  const transient: unknown[] = []
  for (const member of autoIr) {
    await renewCurrentWorkLease()
    try {
      await manageIrForMemberStrict(member)
    } catch (error) {
      failed.add(`${member.league_id}:${member.league_season_id}:${member.member_id}`)
      result.failed++
      result.errors.push(`${member.member_id}: ${errorMessage(error)}`)
      if (isTransientError(error)) transient.push(error)
    }
  }
  const settings = await loadEnabledOptimizerSettings(supabase, [...new Set((games ?? []).map(game => game.season_year))], date)
  for (const setting of settings) {
    const key = `${setting.league_id}:${setting.league_season_id}:${setting.member_id}`
    const leagueKey = `${setting.league_id}:${setting.league_season_id}`
    if (failed.has(key)) continue
    await renewCurrentWorkLease()
    try {
      if (enabledLeagues.has(leagueKey)) {
        if (!strict.has(key)) await manageIrForMemberStrict(setting)
      } else {
        await manageIrForMember(setting)
      }
      const { data, error } = await supabase.rpc('get_pre_tipoff_lineup_context', {
        p_league_id: setting.league_id, p_league_season_id: setting.league_season_id, p_member_id: setting.member_id,
      })
      if (error) throw error
      if (!data) continue
      const context = data as unknown as TipoffContext
      if (context.date !== date) continue
      const playerIds = context.players.filter(player => !player.locked).map(player => player.playerId)
      const projections = playerIds.length ? await supabase.rpc('get_league_projection_rows', {
        p_league_id: setting.league_id, p_season_year: context.seasonYear, p_game_date: date,
        p_view: 'today', p_player_ids: playerIds, p_limit: playerIds.length, p_offset: 0,
      }).select('player_id,projection_fantasy_points') : { data: [], error: null }
      if (projections.error) throw projections.error
      await renewCurrentWorkLease()
      const { data: changed, error: applyError } = await supabase.rpc('apply_daily_lineup', {
        p_game_date: date, p_league_id: setting.league_id, p_league_season_id: setting.league_season_id,
        p_member_id: setting.member_id, p_assignments: tipoffAssignments(context, projections.data ?? []),
      })
      if (applyError) throw applyError
      if (changed) result.optimized++
    } catch (error) {
      if (enabledLeagues.has(leagueKey)) failed.add(key)
      result.failed++
      result.errors.push(`${setting.member_id}: ${errorMessage(error)}`)
      if (enabledLeagues.has(leagueKey) && isTransientError(error)) transient.push(error)
    }
  }
  if (transient.length) throw new AggregateError(transient, 'Daily optimization hit transient transport failures')
  return result
}
