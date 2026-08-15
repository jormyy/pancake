import { supabase } from './supabase.ts'
import { generateMatchups } from './matchupGeneration.ts'
import { runBounded } from './runBounded.ts'

// NBA stat corrections land 1-2 days after games. Bracket generation,
// advancement, and rollover wait this long after the prerequisite week
// finalizes so corrections settle results before they become immutable.
const BOUNDARY_GRACE_HOURS = 48

const BOUNDARY_CONCURRENCY = 5
const DEFAULT_PLAYOFF_START_WEEK = 20

type BoundaryMatchup = {
  matchup_type: string
  week_number: number
  is_finalized: boolean | null
  finalized_at: string | null
  winner_member_id: string | null
}

export type BoundaryLeagueReport = {
  leagueId: string
  actions: string[]
  error?: string
}

function graceElapsed(matchups: BoundaryMatchup[], referenceDate: Date): boolean {
  let latest: number | null = null
  for (const matchup of matchups) {
    if (!matchup.finalized_at) continue
    const finalizedAt = Date.parse(matchup.finalized_at)
    if (Number.isNaN(finalizedAt)) continue
    latest = latest == null ? finalizedAt : Math.max(latest, finalizedAt)
  }
  if (latest == null) return true
  return referenceDate.getTime() >= latest + BOUNDARY_GRACE_HOURS * 3_600_000
}

function allFinalized(matchups: BoundaryMatchup[]): boolean {
  return matchups.length > 0 && matchups.every((m) => m.is_finalized)
}

async function setLeagueStatusPlayoffs(leagueId: string): Promise<void> {
  const { error } = await supabase
    .from('leagues')
    .update({ status: 'playoffs' })
    .eq('id', leagueId)
    .eq('status', 'active')
  if (error) throw error
}

async function processLeagueBoundary(
  leagueId: string,
  leagueSeasonId: string,
  leagueStatus: string,
  playoffStartWeek: number,
  referenceDate: Date,
): Promise<string[]> {
  const actions: string[] = []
  const { data: matchupRows, error: matchupError } = await supabase
    .from('matchups')
    .select('matchup_type, week_number, is_finalized, finalized_at, winner_member_id')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
  if (matchupError) throw matchupError

  const matchups = (matchupRows ?? []) as BoundaryMatchup[]
  const regular = matchups.filter((m) =>
    m.matchup_type === 'regular_season' && m.week_number < playoffStartWeek
  )
  const quarterfinals = matchups.filter((m) => m.matchup_type === 'playoff_quarterfinal')
  const semifinals = matchups.filter((m) => m.matchup_type === 'playoff_semifinal')
  const finals = matchups.filter((m) => m.matchup_type === 'playoff_final')
  const bracketExists = quarterfinals.length > 0 || semifinals.length > 0 || finals.length > 0

  if (!bracketExists) {
    if (!allFinalized(regular) || !graceElapsed(regular, referenceDate)) return actions
    const { error } = await supabase.rpc('generate_playoff_bracket_atomic', {
      p_league_id: leagueId,
    })
    if (error) throw error
    await setLeagueStatusPlayoffs(leagueId)
    actions.push('bracket-generated')
    return actions
  }

  if (leagueStatus === 'active') {
    // A commissioner-generated bracket leaves the league on 'active'; converge
    // so rollover's status gate holds regardless of who generated the bracket.
    await setLeagueStatusPlayoffs(leagueId)
    actions.push('status-playoffs')
  }

  if (finals.length === 0) {
    const currentRound = semifinals.length > 0 ? semifinals : quarterfinals
    const roundDecided = currentRound.every((m) => m.is_finalized && m.winner_member_id != null)
    if (currentRound.length === 0 || !roundDecided || !graceElapsed(currentRound, referenceDate)) {
      return actions
    }
    const { error } = await supabase.rpc('advance_playoff_bracket_atomic', {
      p_league_id: leagueId,
    })
    if (error) throw error
    actions.push(semifinals.length > 0 ? 'final-created' : 'semifinals-created')
    return actions
  }

  const finalDecided = finals.every((m) => m.is_finalized && m.winner_member_id != null)
  if (!finalDecided || !graceElapsed(finals, referenceDate)) return actions

  const { data: advanceRows, error: advanceError } = await supabase.rpc('advance_season_atomic', {
    p_league_id: leagueId,
  })
  if (advanceError) throw advanceError
  actions.push('season-advanced')

  const newSeasonId = advanceRows?.[0]?.new_season_id
  if (typeof newSeasonId === 'string') {
    await generateMatchups(leagueId, newSeasonId, playoffStartWeek - 1)
    actions.push('matchups-generated')
  }
  return actions
}

// Season-boundary automation: per current league season, generate the playoff
// bracket once the regular season finalizes, advance the bracket round by
// round, roll the season over after the final, and generate the next season's
// matchups so scoring resumes. Every step is idempotent and safe to re-run;
// commissioner buttons remain as manual overrides and a league the
// commissioner already advanced is left untouched.
export async function runSeasonBoundary(
  referenceDate = new Date(),
  leagueId?: string,
): Promise<BoundaryLeagueReport[]> {
  let query = supabase
    .from('league_seasons')
    .select('id, league_id, leagues!league_seasons_league_id_fkey ( status, playoff_start_week )')
    .eq('is_current', true)
  if (leagueId) query = query.eq('league_id', leagueId)
  const { data: seasons, error } = await query
  if (error) throw error

  const reports: BoundaryLeagueReport[] = []
  const jobs = (seasons ?? []).flatMap((season) => {
    const league = season.leagues as { status?: string | null; playoff_start_week?: number | null } | null
    const status = league?.status ?? 'setup'
    if (status !== 'active' && status !== 'playoffs') return []
    const playoffStartWeek = league?.playoff_start_week ?? DEFAULT_PLAYOFF_START_WEEK
    return [async () => {
      try {
        const actions = await processLeagueBoundary(
          season.league_id,
          season.id,
          status,
          playoffStartWeek,
          referenceDate,
        )
        reports.push({ leagueId: season.league_id, actions })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[season-boundary] league ${season.league_id} failed: ${message}`)
        reports.push({ leagueId: season.league_id, actions: [], error: message })
      }
    }]
  })
  await runBounded(jobs, BOUNDARY_CONCURRENCY)
  return reports
}
