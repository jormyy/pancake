import { supabase } from './supabase.ts'

const DEFAULT_PLAYOFF_START_WEEK = 20
const LEGACY_SCHEDULE_REQUIRES_ROWS = 'The proposed regular schedule does not match the saved playoff start. Reload settings and retry.'

type RegularSeasonMatchupPayload = {
  league_id: string
  league_season_id: string
  week_number: number
  home_member_id: string
  away_member_id: string
  matchup_type: 'regular_season'
}

function legacyScheduleRows(leagueId: string, seasonId: string, weeks: number, memberIds: string[]): RegularSeasonMatchupPayload[] {
  const teams: (string | null)[] = memberIds.length % 2 === 0 ? memberIds : [...memberIds, null]
  const rotating = teams.slice(1)
  const rows: RegularSeasonMatchupPayload[] = []
  for (let week = 1; week <= weeks; week += 1) {
    const offset = (week - 1) % rotating.length
    const circle = [teams[0], ...rotating.slice(offset), ...rotating.slice(0, offset)]
    for (let index = 0; index < circle.length / 2; index += 1) {
      const home = circle[index]
      const away = circle[circle.length - 1 - index]
      if (home && away) rows.push({
        league_id: leagueId, league_season_id: seasonId, week_number: week,
        home_member_id: home, away_member_id: away, matchup_type: 'regular_season',
      })
    }
  }
  return rows
}

export async function generateMatchups(
  leagueId: string,
  leagueSeasonId: string,
  regularSeasonWeeks: number,
  force = false,
): Promise<void> {
  const { data: members, error: memberError } = await supabase.from('league_members').select('id').eq('league_id', leagueId)
  if (memberError) throw memberError
  if (!members || members.length < 2) return
  const { error } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: leagueId,
    p_league_season_id: leagueSeasonId,
    p_force: force,
  })
  if (!error) return
  if (error.code !== 'P0001' || error.message !== LEGACY_SCHEDULE_REQUIRES_ROWS) throw error
  const { error: legacyError } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: leagueId,
    p_league_season_id: leagueSeasonId,
    p_force: force,
    p_matchups: legacyScheduleRows(leagueId, leagueSeasonId, regularSeasonWeeks, members.map((member) => member.id)),
  })
  if (legacyError) throw legacyError
}

export async function generateAllMatchups(force = false, leagueId?: string): Promise<void> {
  let query = supabase
    .from('league_seasons')
    .select('id, league_id, leagues!league_seasons_league_id_fkey ( playoff_start_week )')
    .eq('is_current', true)
  if (leagueId) query = query.eq('league_id', leagueId)

  const { data: seasons, error } = await query
  if (error) throw error

  await Promise.all((seasons ?? []).map((season) => {
    const league = season.leagues as { playoff_start_week?: number | null } | null
    const playoffStartWeek = league?.playoff_start_week ?? DEFAULT_PLAYOFF_START_WEEK
    return generateMatchups(season.league_id, season.id, playoffStartWeek - 1, force)
  }))
}
