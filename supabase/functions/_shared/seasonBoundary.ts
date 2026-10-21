import { supabase } from './supabase.ts'
import { toETDate } from './date.ts'
import { generateMatchups } from './matchupGeneration.ts'
import { runBounded } from './runBounded.ts'
import { fetchAllPages } from './scoreShared.ts'
import { syncScores } from './syncScores.ts'
import { isRegularSeasonGameId } from './gameId.ts'

// NBA stat corrections land 1-2 days after games. Bracket generation,
// advancement, and rollover wait this long after the prerequisite week
// finalizes so corrections settle results before they become immutable.
const BOUNDARY_GRACE_HOURS = 48

const BOUNDARY_CONCURRENCY = 5
const DEFAULT_PLAYOFF_START_WEEK = 20

type BoundaryMatchup = {
  matchup_type: string
  playoff_round?: number | null
  week_number: number
  is_finalized: boolean | null
  finalized_at: string | null
  winner_member_id: string | null
}

type BoundaryLeagueReport = {
  leagueId: string
  actions: string[]
  error?: string
}

// A league that fails every day would otherwise be invisible: runSeasonBoundary
// catches per league and the invocation used to be recorded as a success.
export function summarizeBoundaryFailures(reports: BoundaryLeagueReport[]): string | null {
  const failed = reports.filter((report) => report.error)
  if (failed.length === 0) return null
  const sample = failed.slice(0, 5).map((report) => `${report.leagueId}: ${report.error}`).join('; ')
  return `${failed.length} of ${reports.length} league(s) failed — ${sample}`
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

async function ensureSeasonMatchups(
  leagueId: string,
  leagueSeasonId: string,
  playoffStartWeek: number,
): Promise<string[]> {
  const { count, error } = await supabase
    .from('matchups')
    .select('id', { count: 'exact', head: true })
    .eq('league_season_id', leagueSeasonId)
  if (error) throw error
  if ((count ?? 0) > 0 || playoffStartWeek === 1) return []
  const { data: season, error: seasonError } = await supabase.from('league_seasons')
    .select('season_year').eq('id', leagueSeasonId).single()
  if (seasonError) throw seasonError
  const { data: calendar, error: calendarError } = await supabase.from('season_weeks')
    .select('week_number').eq('season_year', season.season_year).limit(1)
  if (calendarError) throw calendarError
  if (!calendar?.length) return ['calendar-pending']
  await generateMatchups(leagueId, leagueSeasonId, playoffStartWeek - 1)
  return ['matchups-generated']
}

// Rookie-draft backstop: if the league's first eligible week has begun and the
// league's rookie draft still has not run, start it and complete every pick
// best-available (auto_pick uses nba_draft_number order). Completing the last
// pick activates the league, so the season-boundary loop resumes normally.
// Rookies land on rosters, never silently on waivers.
const MAX_BACKSTOP_PICKS = 200

async function runRookieDraftBackstop(
  leagueId: string,
  leagueSeasonId: string,
  referenceDate: Date,
  startIfMissing = true,
): Promise<string[]> {
  const { data: season, error: seasonError } = await supabase
    .from('league_seasons')
    .select('season_year, skipped_weeks')
    .eq('id', leagueSeasonId)
    .single()
  if (seasonError) throw seasonError

  const { data: weeks, error: weekError } = await supabase
    .from('season_weeks')
    .select('week_number, week_start')
    .eq('season_year', season.season_year)
    .order('week_number')
  if (weekError) throw weekError
  const firstEligibleWeek = weeks?.find((week) => !season.skipped_weeks.includes(week.week_number))
  if (!firstEligibleWeek || toETDate(referenceDate) < firstEligibleWeek.week_start) return []

  const actions: string[] = []
  const { data: drafts, error: draftError } = await supabase
    .from('drafts')
    .select('id, status')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('draft_type', 'snake')
    .eq('is_mock', false)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: true })
  if (draftError) throw draftError

  let draft = drafts?.[0] ?? null
  if (!draft && !startIfMissing) return actions
  if (!draft) {
    const { data: started, error: startError } = await supabase.rpc('start_rookie_draft_atomic', {
      p_league_id: leagueId,
      p_rounds: 3,
      p_is_mock: false,
      p_pick_timer_seconds: 60,
      p_timer_expiry_behavior: 'auto_pick',
    })
    if (startError) throw startError
    draft = started as typeof draft
    actions.push('rookie-draft-started')
  }
  if (!draft || !['in_progress', 'paused'].includes(draft.status)) return actions

  for (let picks = 0; picks < MAX_BACKSTOP_PICKS; picks += 1) {
    const { data: nextPick, error: nextError } = await supabase
      .from('snake_draft_picks')
      .select('id, member_id')
      .eq('draft_id', draft.id)
      .is('player_id', null)
      .is('skipped_at', null)
      .order('overall_pick', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (nextError) throw nextError
    if (!nextPick) break
    const { error: pickError } = await supabase.rpc('auto_pick_snake_pick_atomic', {
      p_draft_id: draft.id,
      p_member_id: nextPick.member_id,
      p_reason: 'season_boundary_backstop',
    })
    if (pickError) throw pickError
  }
  const { count: unfilled, error: unfilledError } = await supabase
    .from('snake_draft_picks')
    .select('id', { count: 'exact', head: true })
    .eq('draft_id', draft.id)
    .is('player_id', null)
    .is('skipped_at', null)
  if (unfilledError) throw unfilledError
  actions.push((unfilled ?? 0) === 0 ? 'rookie-draft-auto-completed' : 'rookie-draft-backstop-partial')
  return actions
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
  allowUnavailableRefresh = true,
): Promise<string[]> {
  const actions: string[] = []
  const matchups = await fetchAllPages<BoundaryMatchup>((from, to) => supabase
    .from('matchups')
    .select('id, matchup_type, playoff_round, week_number, is_finalized, finalized_at, winner_member_id')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('is_voided', false)
    .order('id')
    .range(from, to))
  if (matchups.length === 0 && playoffStartWeek > 1) {
    // A manually-advanced league can reach 'active' (rookie draft completed)
    // before any tick saw it in 'offseason', leaving a season with no
    // schedule at all. Backfill instead of silently never scoring.
    return await ensureSeasonMatchups(leagueId, leagueSeasonId, playoffStartWeek)
  }
  const regular = matchups.filter((m) =>
    m.matchup_type === 'regular_season' && m.week_number < playoffStartWeek
  )
  const quarterfinals = matchups.filter((m) => m.matchup_type === 'playoff_quarterfinal')
  const semifinals = matchups.filter((m) => m.matchup_type === 'playoff_semifinal')
  const finals = matchups.filter((m) => m.matchup_type === 'playoff_final')
  const bracketExists = quarterfinals.length > 0 || semifinals.length > 0 || finals.length > 0

  if (!bracketExists) {
    if (!allFinalized(regular)) {
      if (!allowUnavailableRefresh) throw new Error('Regular-season scores remain incomplete after confirmed-unavailability refresh')
      if (await refreshUnavailableRegularSeason(leagueId, leagueSeasonId, regular, referenceDate)) {
        return await processLeagueBoundary(leagueId, leagueSeasonId, leagueStatus, playoffStartWeek, referenceDate, false)
      }
    }
    if (playoffStartWeek > 1 && (!allFinalized(regular) || !graceElapsed(regular, referenceDate))) return actions
    const result = await applyBoundaryWithScoreRefresh(leagueId, leagueSeasonId, 'generate', referenceDate, regular)
    if (result.applied === true) actions.push('bracket-generated')
    return actions
  }

  if (leagueStatus === 'active') {
    // A commissioner-generated bracket leaves the league on 'active'; converge
    // so rollover's status gate holds regardless of who generated the bracket.
    await setLeagueStatusPlayoffs(leagueId)
    actions.push('status-playoffs')
  }

  if (finals.length === 0) {
    const latestRound = matchups.reduce((latest, matchup) => Math.max(latest, matchup.playoff_round ?? 0), 0)
    const currentRound = latestRound > 0 ? matchups.filter((matchup) => matchup.playoff_round === latestRound)
      : semifinals.length > 0 ? semifinals : quarterfinals
    const roundDecided = currentRound.every((m) => m.is_finalized && m.winner_member_id != null)
    if (currentRound.length === 0 || !roundDecided || !graceElapsed(currentRound, referenceDate)) {
      return actions
    }
    const result = await applyBoundaryWithScoreRefresh(leagueId, leagueSeasonId, 'advance', referenceDate, currentRound)
    if (result.applied === true) actions.push(semifinals.length > 0 ? 'final-created' : latestRound > 0 ? 'round-created' : 'semifinals-created')
    return actions
  }

  const finalDecided = finals.every((m) => m.is_finalized && m.winner_member_id != null)
  if (!finalDecided || !graceElapsed(finals, referenceDate)) return actions

  const result = await applyBoundaryWithScoreRefresh(leagueId, leagueSeasonId, 'rollover', referenceDate, [...regular, ...finals])
  if (result.applied !== true) return actions
  actions.push('season-advanced')

  const newSeasonId = result.new_season_id
  if (typeof newSeasonId === 'string' && playoffStartWeek > 1) {
    actions.push(...await ensureSeasonMatchups(leagueId, newSeasonId, playoffStartWeek))
  }
  return actions
}

async function staleBoundaryWeeks(seasonId: string, weeks: number[]): Promise<number[]> {
  if (weeks.length === 0) return []
  const rows = await fetchAllPages<{ week_number: number }>((from, to) => supabase
    .rpc('get_stale_score_weeks', { p_league_season_id: seasonId, p_through_week: Math.max(...weeks) })
    .in('week_number', weeks)
    .order('week_number', { ascending: true })
    .range(from, to))
  return rows.map((row) => row.week_number)
}

async function applyBoundaryWithScoreRefresh(
  leagueId: string,
  seasonId: string,
  action: 'generate' | 'advance' | 'rollover',
  referenceDate: Date,
  prerequisites: BoundaryMatchup[],
) {
  const result = await applyBoundaryAfterGrace(leagueId, seasonId, action, referenceDate)
  if (result.applied === true) return result
  const weeks = [...new Set(prerequisites.map((matchup) => matchup.week_number))]
  const stale = await staleBoundaryWeeks(seasonId, weeks)
  if (stale.length === 0) return result
  await syncScores(leagueId, referenceDate, { recoverStats: false })
  const refreshed = await applyBoundaryAfterGrace(leagueId, seasonId, action, referenceDate)
  if (refreshed.applied !== true && (await staleBoundaryWeeks(seasonId, weeks)).length > 0) {
    throw new Error('Score certificates remain stale after boundary refresh. Retry scoring.')
  }
  return refreshed
}

async function applyBoundaryAfterGrace(
  leagueId: string,
  seasonId: string,
  action: 'generate' | 'advance' | 'rollover',
  referenceDate: Date,
) {
  const { data, error } = await supabase.rpc('apply_season_boundary_after_grace', {
    p_league_id: leagueId,
    p_league_season_id: seasonId,
    p_action: action,
    p_reference_at: referenceDate.toISOString(),
  })
  if (error) throw error
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Automatic season boundary returned no result.')
  }
  return data
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
  type CurrentSeason = {
    id: string
    league_id: string
    leagues: { status: string; playoff_start_week: number } | null
  }
  const seasons: CurrentSeason[] = []
  let afterId: string | undefined
  while (true) {
    let query = supabase
      .from('league_seasons')
      .select('id, league_id, leagues!league_seasons_league_id_fkey!inner ( status, playoff_start_week )')
      .eq('is_current', true)
      .in('leagues.status', ['active', 'playoffs', 'offseason', 'drafting'])
      .order('id')
      .limit(1000)
    if (leagueId) query = query.eq('league_id', leagueId)
    if (afterId) query = query.gt('id', afterId)
    const { data, error } = await query
    if (error) throw error
    const page = data as CurrentSeason[]
    if (!page?.length) break
    seasons.push(...page)
    afterId = page[page.length - 1].id
    if (page.length < 1000) break
  }

  const reports: BoundaryLeagueReport[] = []
  const jobs = (seasons ?? []).flatMap((season) => {
    const league = season.leagues as { status?: string | null; playoff_start_week?: number | null } | null
    const status = league?.status ?? 'setup'
    if (status !== 'active' && status !== 'playoffs' && status !== 'offseason' && status !== 'drafting') return []
    const playoffStartWeek = league?.playoff_start_week ?? DEFAULT_PLAYOFF_START_WEEK
    return [async () => {
      try {
        const actions = status === 'offseason'
          // A commissioner who advanced the season manually leaves the new
          // season without matchups (advanceSeason never generated them).
          // Backfill only when none exist; everything else is left untouched.
          ? [
            ...await ensureSeasonMatchups(season.league_id, season.id, playoffStartWeek),
            ...await runRookieDraftBackstop(season.league_id, season.id, referenceDate),
          ]
          : status === 'drafting'
          ? await runRookieDraftBackstop(season.league_id, season.id, referenceDate, false)
          : await processLeagueBoundary(
            season.league_id,
            season.id,
            status,
            playoffStartWeek,
            referenceDate,
          )
        reports.push({ leagueId: season.league_id, actions })
      } catch (error) {
        const message = (error as { message?: string } | null)?.message ?? JSON.stringify(error)
        console.error(`[season-boundary] league ${season.league_id} failed: ${message}`)
        reports.push({ leagueId: season.league_id, actions: [], error: message })
      }
    }]
  })
  await runBounded(jobs, BOUNDARY_CONCURRENCY)
  return reports
}

async function refreshUnavailableRegularSeason(
  leagueId: string,
  seasonId: string,
  matchups: BoundaryMatchup[],
  referenceDate: Date,
): Promise<boolean> {
  const weekNumbers = [...new Set(matchups.map((matchup) => matchup.week_number))]
  if (weekNumbers.length === 0) return false
  const { data: season, error: seasonError } = await supabase.from('league_seasons')
    .select('season_year').eq('id', seasonId).single()
  if (seasonError) throw seasonError
  const { data: lastWeek, error: weekError } = await supabase.from('season_weeks')
    .select('week_end').eq('season_year', season.season_year).eq('week_number', Math.max(...weekNumbers)).maybeSingle()
  if (weekError) throw weekError
  if (!lastWeek || toETDate(referenceDate) <= lastWeek.week_end) return false
  const games = await fetchAllPages<{ nba_game_id: string | null; status: string; game_status_text: string | null; stats_synced_at: string | null }>((from, to) => supabase
    .from('nba_games').select('nba_game_id,status,game_status_text,stats_synced_at')
    .eq('season_year', season.season_year).in('week_number', weekNumbers).order('id').range(from, to))
  const regularGames = games.filter((game) => isRegularSeasonGameId(game.nba_game_id))
  const unavailable = (game: typeof regularGames[number]) => /postpon|cancel|suspend|(^|[^a-z])ppd([^a-z]|$)/i.test(game.game_status_text ?? '')
  if (!regularGames.some(unavailable) || regularGames.some((game) => !unavailable(game) && (game.status !== 'Final' || !game.stats_synced_at))) return false
  await syncScores(leagueId, referenceDate, { recoverStats: false })
  return true
}
