import { supabase } from '../_shared/supabase.ts'
import { throwDb } from '../_shared/apiRuntime.ts'
import type { Database } from '../_shared/database.ts'

const DEFAULT_PLAYOFF_START_WEEK = 20
const PLAYOFF_MATCHUP_TYPES = ['playoff_quarterfinal', 'playoff_semifinal', 'playoff_final'] as const
type MatchupInsert = Database['public']['Tables']['matchups']['Insert']

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

async function assertCanForceRegenerate(leagueSeasonId: string): Promise<void> {
  const [finalizedRes, playoffRes] = await Promise.all([
    supabase
      .from('matchups')
      .select('id', { count: 'exact', head: true })
      .eq('league_season_id', leagueSeasonId)
      .eq('is_finalized', true),
    supabase
      .from('matchups')
      .select('id', { count: 'exact', head: true })
      .eq('league_season_id', leagueSeasonId)
      .in('matchup_type', PLAYOFF_MATCHUP_TYPES),
  ])

  if (finalizedRes.error) throwDb(finalizedRes.error)
  if (playoffRes.error) throwDb(playoffRes.error)
  if ((finalizedRes.count ?? 0) > 0 || (playoffRes.count ?? 0) > 0) {
    throw new Error('Cannot force-regenerate matchups after finalized or playoff matchups exist.')
  }
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

  const { count, error: countError } = await supabase
    .from('matchups')
    .select('id', { count: 'exact', head: true })
    .eq('league_season_id', leagueSeasonId)
  if (countError) throwDb(countError)

  if ((count ?? 0) > 0) {
    if (!force) return
    await assertCanForceRegenerate(leagueSeasonId)
    const { error } = await supabase.from('matchups').delete().eq('league_season_id', leagueSeasonId)
    if (error) throwDb(error)
  }

  const memberIds = members.map((member) => member.id)
  const rounds = roundRobinRounds(memberIds)
  const rows: MatchupInsert[] = []

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

  const { error } = await supabase.from('matchups').insert(rows)
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
