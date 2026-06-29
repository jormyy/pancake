import { todayET } from '../_shared/date.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  booleanField,
  json,
  NotFoundError,
  readJsonObject,
  requireCommissioner,
  requireUser,
  throwDb,
  uuidField,
  ValidationError,
} from '../_shared/apiRuntime.ts'

function addDaysToETDate(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)).toISOString().slice(0, 10)
}

function isRosterToggleLockedGame(
  game: { game_date: string; status: string | null; game_time: string | null; started_at: string | null },
  today: string,
  now: Date,
): boolean {
  const nowTime = now.getTime()
  const recentWindowStart = nowTime - 12 * 60 * 60 * 1000
  if (game.status === 'InProgress') return true
  if (game.game_date === today && game.status === 'Final') return true

  for (const value of [game.game_time, game.started_at]) {
    if (!value) continue
    const startedTime = Date.parse(value)
    if (Number.isNaN(startedTime) || startedTime > nowTime) continue
    if (game.game_date === today || startedTime >= recentWindowStart) return true
  }
  return false
}

async function assertRosterToggleUnlocked(rosterPlayerId: string, userId: string): Promise<void> {
  const gameDate = todayET()
  const candidateDates = [addDaysToETDate(gameDate, -1), gameDate]
  const { data: rosterPlayer, error: rosterError } = await supabase
    .from('roster_players')
    .select('id, players!inner(display_name, nba_team), league_members!inner(user_id)')
    .eq('id', rosterPlayerId)
    .eq('league_members.user_id', userId)
    .maybeSingle()

  if (rosterError) throwDb(rosterError)
  if (!rosterPlayer) throw new NotFoundError('Roster player not found')

  const player = rosterPlayer.players as { display_name?: string | null; nba_team?: string | null } | null
  const team = player?.nba_team
  if (!team) return

  const { data: games, error: gameError } = await supabase
    .from('nba_games')
    .select('id, game_date, status, game_time, started_at')
    .in('game_date', candidateDates)
    .or(`home_team.eq.${team},away_team.eq.${team}`)

  if (gameError) throwDb(gameError)
  if ((games ?? []).some((game) => isRosterToggleLockedGame(game, gameDate, new Date()))) {
    throw new ValidationError(`${player?.display_name ?? 'This player'}'s game has already started. No roster status changes are allowed for that slate.`)
  }
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
  await assertRosterToggleUnlocked(rosterPlayerId, userId)
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

  return null
}
