import { supabase } from '../_shared/supabase.ts'
import type { Database } from '../_shared/database.ts'
import {
  json,
  readJsonObject,
  requireCommissioner,
  requireUser,
  throwDb,
  uuidField,
  ValidationError,
} from '../_shared/apiRuntime.ts'

const DEFAULT_PLAYOFF_START_WEEK = 20
type MatchupInsert = Database['public']['Tables']['matchups']['Insert']
type RpsChallengeInsert = Database['public']['Tables']['rps_challenges']['Insert']

type PlayoffSeed = {
  memberId: string
  wins: number
  pointsFor: number
  maxPossiblePoints: number
  pointsAgainst: number
  tieToken: string
}

type SeasonContext = {
  seasonId: string
  seasonYear: number
  playoffStartWeek: number
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getSeasonContext(leagueId: string): Promise<SeasonContext> {
  const { data: season, error: seasonError } = await supabase
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  if (seasonError) throwDb(seasonError)

  const { data: league, error: leagueError } = await supabase
    .from('leagues')
    .select('playoff_start_week')
    .eq('id', leagueId)
    .single()
  if (leagueError) throwDb(leagueError)

  return {
    seasonId: season.id,
    seasonYear: season.season_year,
    playoffStartWeek: league.playoff_start_week ?? DEFAULT_PLAYOFF_START_WEEK,
  }
}

async function assertRegularSeasonFinalized(leagueSeasonId: string, playoffStartWeek: number): Promise<void> {
  const { data, error } = await supabase
    .from('matchups')
    .select('id')
    .eq('league_season_id', leagueSeasonId)
    .eq('matchup_type', 'regular_season')
    .lt('week_number', playoffStartWeek)
    .eq('is_finalized', false)
    .limit(1)
  if (error) throwDb(error)
  if ((data ?? []).length > 0) {
    throw new ValidationError('Regular season matchups must be finalized before generating playoffs.')
  }
}

function compareStandingsMetrics(a: PlayoffSeed, b: PlayoffSeed): number {
  return b.wins - a.wins ||
    b.pointsFor - a.pointsFor ||
    b.maxPossiblePoints - a.maxPossiblePoints ||
    a.pointsAgainst - b.pointsAgainst
}

function comparePlayoffSeeds(a: PlayoffSeed, b: PlayoffSeed): number {
  return compareStandingsMetrics(a, b) ||
    a.tieToken.localeCompare(b.tieToken) ||
    a.memberId.localeCompare(b.memberId)
}

async function getPlayoffSeeds(
  leagueId: string,
  leagueSeasonId: string,
  playoffStartWeek: number,
): Promise<PlayoffSeed[]> {
  const { data: matchups, error: matchupError } = await supabase
    .from('matchups')
    .select('home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized')
    .eq('league_season_id', leagueSeasonId)
    .eq('matchup_type', 'regular_season')
    .lt('week_number', playoffStartWeek)
    .eq('is_finalized', true)
  if (matchupError) throwDb(matchupError)

  const { data: members, error: memberError } = await supabase
    .from('league_members')
    .select('id')
    .eq('league_id', leagueId)
  if (memberError) throwDb(memberError)

  const stats = new Map<string, PlayoffSeed>()
  for (const member of members ?? []) {
    stats.set(member.id, {
      memberId: member.id,
      wins: 0,
      pointsFor: 0,
      maxPossiblePoints: 0,
      pointsAgainst: 0,
      tieToken: await sha256Hex(`${leagueSeasonId}:${member.id}`),
    })
  }

  for (const matchup of matchups ?? []) {
    const home = stats.get(matchup.home_member_id)
    const away = stats.get(matchup.away_member_id)
    const homePoints = Number(matchup.home_points ?? 0)
    const awayPoints = Number(matchup.away_points ?? 0)

    if (home) {
      home.pointsFor += homePoints
      home.pointsAgainst += awayPoints
      home.maxPossiblePoints += Number(matchup.home_max_possible_points ?? 0)
    }
    if (away) {
      away.pointsFor += awayPoints
      away.pointsAgainst += homePoints
      away.maxPossiblePoints += Number(matchup.away_max_possible_points ?? 0)
    }
    if (matchup.is_finalized && matchup.winner_member_id) {
      const winner = stats.get(matchup.winner_member_id)
      if (winner) winner.wins += 1
    }
  }

  return [...stats.values()].sort(comparePlayoffSeeds)
}

function rpsPairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

function sameTiebreaker(a: PlayoffSeed, b: PlayoffSeed): boolean {
  return a.wins === b.wins &&
    a.pointsFor === b.pointsFor &&
    a.maxPossiblePoints === b.maxPossiblePoints &&
    a.pointsAgainst === b.pointsAgainst
}

function relevantTiebreakerPairs(
  seeds: PlayoffSeed[],
  playoffSize: number,
): { memberAId: string; memberBId: string; winnerMemberId: string }[] {
  const tiedPairs: { memberAId: string; memberBId: string; winnerMemberId: string }[] = []
  let index = 0
  while (index < seeds.length) {
    let next = index + 1
    while (next < seeds.length && sameTiebreaker(seeds[index], seeds[next])) next += 1
    if (index >= playoffSize) break
    for (let i = index; i < next; i += 1) {
      for (let j = i + 1; j < next; j += 1) {
        const a = seeds[i]
        const b = seeds[j]
        tiedPairs.push({
          memberAId: a.memberId,
          memberBId: b.memberId,
          winnerMemberId: comparePlayoffSeeds(a, b) <= 0 ? a.memberId : b.memberId,
        })
      }
    }
    index = next > index + 1 ? next : index + 1
  }
  return tiedPairs
}

async function recordTiebreakerAuditRows(
  leagueId: string,
  leagueSeasonId: string,
  seeds: PlayoffSeed[],
  playoffSize: number,
): Promise<void> {
  const tiedPairs = relevantTiebreakerPairs(seeds, playoffSize)
  if (tiedPairs.length === 0) return

  const { data: existing, error: existingError } = await supabase
    .from('rps_challenges')
    .select('id, member_a_id, member_b_id, winner_member_id, status')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('context', 'standings_playoff_tiebreaker')
  if (existingError) throwDb(existingError)

  const existingByPair = new Map(
    (existing ?? []).map((challenge) => [rpsPairKey(challenge.member_a_id, challenge.member_b_id), challenge]),
  )
  const resolvedAt = new Date().toISOString()
  const rows: RpsChallengeInsert[] = tiedPairs
    .filter((pair) => !existingByPair.has(rpsPairKey(pair.memberAId, pair.memberBId)))
    .map((pair) => ({
      league_id: leagueId,
      league_season_id: leagueSeasonId,
      member_a_id: pair.memberAId,
      member_b_id: pair.memberBId,
      winner_member_id: pair.winnerMemberId,
      status: 'completed' as const,
      context: 'standings_playoff_tiebreaker',
      resolved_at: resolvedAt,
    }))

  if (rows.length > 0) {
    const { error } = await supabase.from('rps_challenges').insert(rows)
    if (error) throwDb(error)
  }

  for (const pair of tiedPairs) {
    const existingChallenge = existingByPair.get(rpsPairKey(pair.memberAId, pair.memberBId))
    if (
      !existingChallenge ||
      (existingChallenge.status === 'completed' && existingChallenge.winner_member_id === pair.winnerMemberId)
    ) {
      continue
    }
    const { error } = await supabase
      .from('rps_challenges')
      .update({
        winner_member_id: pair.winnerMemberId,
        member_a_choice: null,
        member_b_choice: null,
        status: 'completed',
        resolved_at: resolvedAt,
      })
      .eq('id', existingChallenge.id)
    if (error) throwDb(error)
  }
}

async function assertPlayoffWeeksAvailable(
  seasonYear: number,
  playoffStartWeek: number,
  playoffRounds: number,
): Promise<void> {
  const { data: lastWeek, error } = await supabase
    .from('season_weeks')
    .select('week_number')
    .eq('season_year', seasonYear)
    .order('week_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throwDb(error)

  const lastWeekNumber = Number(lastWeek?.week_number ?? 0)
  const finalPlayoffWeek = playoffStartWeek + playoffRounds - 1
  if (!Number.isFinite(lastWeekNumber) || lastWeekNumber < finalPlayoffWeek) {
    throw new ValidationError('Playoff start week does not leave enough season weeks for every playoff round.')
  }
}

async function generateSemifinals(leagueId: string): Promise<void> {
  const { seasonId, seasonYear, playoffStartWeek } = await getSeasonContext(leagueId)
  await assertRegularSeasonFinalized(seasonId, playoffStartWeek)

  const { count, error: playoffCountError } = await supabase
    .from('matchups')
    .select('id', { count: 'exact', head: true })
    .eq('league_season_id', seasonId)
    .in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal'])
  if (playoffCountError) throwDb(playoffCountError)
  if ((count ?? 0) > 0) return

  const seeds = await getPlayoffSeeds(leagueId, seasonId, playoffStartWeek)
  if (seeds.length < 4) throw new ValidationError('Not enough teams to seed playoffs (need 4).')
  const playoffSize = seeds.length >= 10 ? 6 : 4
  await assertPlayoffWeeksAvailable(seasonYear, playoffStartWeek, playoffSize >= 6 ? 3 : 2)
  await recordTiebreakerAuditRows(leagueId, seasonId, seeds, playoffSize)

  const seededMemberIds = seeds.slice(0, playoffSize).map((seed) => seed.memberId)
  const rows: MatchupInsert[] = playoffSize >= 6
    ? [
      {
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: playoffStartWeek,
        matchup_type: 'playoff_quarterfinal' as const,
        home_member_id: seededMemberIds[2],
        away_member_id: seededMemberIds[5],
      },
      {
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: playoffStartWeek,
        matchup_type: 'playoff_quarterfinal' as const,
        home_member_id: seededMemberIds[3],
        away_member_id: seededMemberIds[4],
      },
    ]
    : [
      {
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: playoffStartWeek,
        matchup_type: 'playoff_semifinal' as const,
        home_member_id: seededMemberIds[0],
        away_member_id: seededMemberIds[3],
      },
      {
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: playoffStartWeek,
        matchup_type: 'playoff_semifinal' as const,
        home_member_id: seededMemberIds[1],
        away_member_id: seededMemberIds[2],
      },
    ]

  const { error } = await supabase.from('matchups').insert(rows)
  if (error) throwDb(error)
}

async function advanceToFinal(leagueId: string): Promise<void> {
  const { seasonId } = await getSeasonContext(leagueId)

  const { count: finalCount, error: finalCountError } = await supabase
    .from('matchups')
    .select('id', { count: 'exact', head: true })
    .eq('league_season_id', seasonId)
    .eq('matchup_type', 'playoff_final')
  if (finalCountError) throwDb(finalCountError)
  if ((finalCount ?? 0) > 0) return

  const { data: quarterfinals, error: qfError } = await supabase
    .from('matchups')
    .select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')
    .eq('league_season_id', seasonId)
    .eq('matchup_type', 'playoff_quarterfinal')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (qfError) throwDb(qfError)

  if ((quarterfinals ?? []).length > 0) {
    const quarterfinalWeek = Math.min(...(quarterfinals ?? []).map((matchup) => Number(matchup.week_number)))
    const { count: semiCount, error: semiCountError } = await supabase
      .from('matchups')
      .select('id', { count: 'exact', head: true })
      .eq('league_season_id', seasonId)
      .eq('matchup_type', 'playoff_semifinal')
    if (semiCountError) throwDb(semiCountError)
    if ((semiCount ?? 0) === 0) {
      const unfinished = (quarterfinals ?? []).filter((matchup) => !matchup.is_finalized)
      if (unfinished.length > 0) throw new ValidationError('Quarterfinals are not yet finalized.')

      const { data: season, error: seasonError } = await supabase
        .from('league_seasons')
        .select('league_id')
        .eq('id', seasonId)
        .single()
      if (seasonError) throwDb(seasonError)

      const seeds = await getPlayoffSeeds(season.league_id, seasonId, quarterfinalWeek)
      const qfWinners = (quarterfinals ?? []).map((matchup) => matchup.winner_member_id).filter((id): id is string => Boolean(id))
      if (qfWinners.length < 2) throw new ValidationError('Could not determine quarterfinal winners.')

      const { error } = await supabase.from('matchups').insert([
        {
          league_id: leagueId,
          league_season_id: seasonId,
          week_number: quarterfinalWeek + 1,
          matchup_type: 'playoff_semifinal' as const,
          home_member_id: seeds[0].memberId,
          away_member_id: qfWinners[1],
        },
        {
          league_id: leagueId,
          league_season_id: seasonId,
          week_number: quarterfinalWeek + 1,
          matchup_type: 'playoff_semifinal' as const,
          home_member_id: seeds[1].memberId,
          away_member_id: qfWinners[0],
        },
      ])
      if (error) throwDb(error)
      return
    }
  }

  const { data: semis, error: semiError } = await supabase
    .from('matchups')
    .select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')
    .eq('league_season_id', seasonId)
    .eq('matchup_type', 'playoff_semifinal')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (semiError) throwDb(semiError)
  if (!semis || semis.length < 2) throw new ValidationError('Semifinals not found.')
  if (semis.some((matchup) => !matchup.is_finalized)) throw new ValidationError('Semifinals are not yet finalized.')

  const winners = semis.map((matchup) => matchup.winner_member_id).filter((id): id is string => Boolean(id))
  if (winners.length < 2) throw new ValidationError('Could not determine semifinal winners.')
  const finalWeek = Math.max(...semis.map((matchup) => Number(matchup.week_number))) + 1

  const { error } = await supabase.from('matchups').insert({
    league_id: leagueId,
    league_season_id: seasonId,
    week_number: finalWeek,
    matchup_type: 'playoff_final' as const,
    home_member_id: winners[0],
    away_member_id: winners[1],
  })
  if (error) throwDb(error)
}

export async function handlePlayoffRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null
  if (path !== '/playoffs/generate' && path !== '/playoffs/advance') return null

  const userId = await requireUser(req)
  const body = await readJsonObject(req)
  const leagueId = uuidField(body, 'leagueId')
  await requireCommissioner(userId, leagueId)

  if (path === '/playoffs/generate') await generateSemifinals(leagueId)
  else await advanceToFinal(leagueId)

  return json({ ok: true })
}
