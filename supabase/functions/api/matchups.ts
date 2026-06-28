import { supabase } from '../_shared/supabase.ts'
import { throwDb } from '../_shared/apiRuntime.ts'

const DEFAULT_PLAYOFF_START_WEEK = 20

type RegularSeasonMatchupPayload = {
  league_id: string
  league_season_id: string
  week_number: number
  home_member_id: string
  away_member_id: string
  matchup_type: 'regular_season'
}

export function roundRobinRounds(ids: string[]): { home: string; away: string }[][] {
  const teams = ids.length % 2 === 0 ? [...ids] : [...ids, '__bye__']
  const n = teams.length
  const rounds: { home: string; away: string }[][] = []

  for (let r = 0; r < n - 1; r += 1) {
    const fixed = teams[0]
    const rotating = teams.slice(1)
    const rotated = [...rotating.slice(r), ...rotating.slice(0, r)]
    const circle = [fixed, ...rotated]

    const pairings: { home: string; away: string }[] = []
    for (let i = 0; i < n / 2; i += 1) {
      const home = circle[i]
      const away = circle[n - 1 - i]
      if (home !== '__bye__' && away !== '__bye__') pairings.push({ home, away })
    }
    rounds.push(pairings)
  }
  return rounds
}

export async function generateMatchups(
  leagueId: string,
  leagueSeasonId: string,
  regularSeasonWeeks: number,
  force = false,
): Promise<void> {
  const { data: members, error: memberError } = await supabase
    .from('league_members')
    .select('id')
    .eq('league_id', leagueId)
  if (memberError) throwDb(memberError)
  if (!members || members.length < 2) return

  const memberIds = members.map((member) => member.id)
  const rounds = roundRobinRounds(memberIds)
  const rows: RegularSeasonMatchupPayload[] = []

  for (let week = 1; week <= regularSeasonWeeks; week += 1) {
    const round = rounds[(week - 1) % rounds.length]
    for (const { home, away } of round) {
      rows.push({
        league_id: leagueId,
        league_season_id: leagueSeasonId,
        week_number: week,
        home_member_id: home,
        away_member_id: away,
        matchup_type: 'regular_season',
      })
    }
  }

  const { error } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: leagueId,
    p_league_season_id: leagueSeasonId,
    p_force: force,
    p_matchups: rows,
  })
  if (error) throwDb(error)
}

export async function generateAllMatchups(force = false, leagueId?: string): Promise<void> {
  let query = supabase
    .from('league_seasons')
    .select('id, league_id, leagues ( playoff_start_week )')
    .eq('is_current', true)
  if (leagueId) query = query.eq('league_id', leagueId)

  const { data: seasons, error } = await query
  if (error) throwDb(error)

  await Promise.all((seasons ?? []).map((season) => {
    const league = season.leagues as { playoff_start_week?: number | null } | null
    const playoffStartWeek = league?.playoff_start_week ?? DEFAULT_PLAYOFF_START_WEEK
    return generateMatchups(season.league_id, season.id, playoffStartWeek - 1, force)
  }))
}
