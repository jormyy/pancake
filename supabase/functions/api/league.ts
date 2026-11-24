import { parseManualDateFilter } from '../lineup-optimizer/manual.ts'
import { playoffFit } from '../_shared/schedule.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  booleanField,
  integerField,
  invokeInternalFunction,
  json,
  readJsonObject,
  requireCommissioner,
  requireOwnMember,
  requireUser,
  throwDb,
  uuidField,
  ValidationError,
} from '../_shared/apiRuntime.ts'

async function autoSetRestOfSeason(
  userId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const memberId = uuidField(body, 'memberId')
  const leagueId = uuidField(body, 'leagueId')
  const leagueSeasonId = uuidField(body, 'leagueSeasonId')
  const membership = await requireOwnMember(userId, memberId)
  if (membership.leagueId !== leagueId) throw new ValidationError('Access denied')

  let dates: string[] | undefined
  try {
    dates = parseManualDateFilter(body.dates)
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : 'Invalid retry dates.')
  }

  return invokeInternalFunction('lineup-optimizer', {
    mode: 'rest_of_season',
    ...(dates ? { dates } : {}),
    memberId,
    leagueId,
    leagueSeasonId,
  })
}

export async function advanceSeason(leagueId: string): Promise<{ newSeasonId: string; newYear: number }> {
  const { data, error } = await supabase.rpc('advance_season_atomic', { p_league_id: leagueId })
  if (error) throwDb(error)

  const row = Array.isArray(data)
    ? data[0] as { new_season_id?: string; new_year?: number } | undefined
    : null
  if (!row?.new_season_id || !row.new_year) throw new Error('Season reset did not return a new season')
  return { newSeasonId: row.new_season_id, newYear: row.new_year }
}

async function toggleRosterFlag(
  rosterPlayerId: string,
  userId: string,
  rpcName: 'toggle_ir_atomic' | 'toggle_taxi_atomic',
  flag: boolean,
): Promise<void> {
  const { error } = rpcName === 'toggle_ir_atomic'
    ? await supabase.rpc(rpcName, {
      p_roster_player_id: rosterPlayerId,
      p_to_ir: flag,
      p_user_id: userId,
    })
    : await supabase.rpc(rpcName, {
      p_roster_player_id: rosterPlayerId,
      p_to_taxi: flag,
      p_user_id: userId,
    })
  if (error) throwDb(error)
}

export async function handleLeagueRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null

  if (path === '/league/playoff-fit') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    await requireCommissioner(userId, leagueId)
    const start = integerField(body, 'start', { min: 1 })
    const rounds = body.rounds
    if (!Array.isArray(rounds) || rounds.length === 0 || rounds.some(length => !Number.isSafeInteger(length) || length < 1)) {
      throw new ValidationError('Enter positive whole weeks for each playoff round.')
    }
    const { data: season, error: seasonError } = await supabase.from('league_seasons').select('season_year').eq('league_id', leagueId).eq('is_current', true).single()
    if (seasonError) throwDb(seasonError)
    const { data: weeks, error } = await supabase.from('season_weeks').select('week_number').eq('season_year', season!.season_year)
    if (error) throwDb(error)
    return json(playoffFit((weeks ?? []).map(week => week.week_number), start, rounds))
  }

  if (path === '/league/advance-season') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    await requireCommissioner(userId, leagueId)
    return json({ ok: true, ...await advanceSeason(leagueId) })
  }

  if (path === '/league/roster/ir') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    await toggleRosterFlag(uuidField(body, 'rosterPlayerId'), userId, 'toggle_ir_atomic', booleanField(body, 'isOnIR'))
    return json({ ok: true })
  }

  if (path === '/league/roster/taxi') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    await toggleRosterFlag(uuidField(body, 'rosterPlayerId'), userId, 'toggle_taxi_atomic', booleanField(body, 'isOnTaxi'))
    return json({ ok: true })
  }

  if (path === '/league/lineup/auto-set-season') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    return json(await autoSetRestOfSeason(userId, body))
  }

  return null
}
