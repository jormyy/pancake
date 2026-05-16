import { supabase } from './supabase.ts'
import { calculateFantasyPoints, snakeToStatLine, getWeekBounds, getWeekNumberForDate } from './scoring.ts'
import { notifyMember } from './notifications.ts'

type MatchupForScore = {
  id: string
  league_id: string
  league_season_id: string
  week_number: number
  home_member_id: string
  away_member_id: string
}

type LineupPlayer = {
  member_id: string
  player_id: string
}

type LineupSlot = LineupPlayer & {
  slot_type: string
}

type StatRow = Record<string, unknown> & {
  player_id: string
}

type MatchupForFinalization = {
  id: string
  home_member_id: string
  away_member_id: string
  home_points: number | null
  away_points: number | null
}

type StandingSnapshot = {
  member_id: string
  wins: number
  losses: number
  ties: number
  points_for: number
  points_against: number
  max_possible_points: number
  waiver_priority: number
}

export async function syncScores() {
  const { data: seasons, error: sErr } = await supabase
    .from('league_seasons')
    .select('id, league_id, season_year, leagues ( scoring_settings )')
    .eq('is_current', true)
  if (sErr) throw sErr
  if (!seasons?.length) return

  for (const season of seasons) {
    const league = season.leagues as any
    const settings: Record<string, number> = league?.scoring_settings ?? {}

    const weekNumber = await getWeekNumberForDate(new Date(), season.season_year)
    if (!weekNumber) {
      console.log(`[sync-scores] No current week for season ${season.season_year}`)
      continue
    }
    // Score every week the season covers — regular season AND playoff weeks
    // (QF at playoff_start_week, SF at +1, Final at +2). updateWeekPoints and
    // finalizeWeekIfComplete are matchup-type agnostic: they sum lineup×stats
    // for whichever matchup rows exist at the given week. Skipping playoff
    // weeks here would leave bracket matchups with null home_points/away_points
    // forever, blocking advanceToFinal.

    await updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber, settings)
    if (weekNumber > 1) {
      await updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber - 1, settings)
    }

    await finalizeWeekIfComplete(season.league_id, season.id, weekNumber, season.season_year, settings)
    if (weekNumber > 1) await finalizeWeekIfComplete(season.league_id, season.id, weekNumber - 1, season.season_year, settings)
  }

  console.log('[sync-scores] Sync complete.')
}

async function calcWeekPointsByMember(
  memberIds: string[],
  leagueSeasonId: string,
  seasonYear: number,
  weekNumber: number,
  settings: Record<string, number>,
  weekStart: string,
  weekEnd: string,
): Promise<Map<string, number>> {
  if (memberIds.length === 0) return new Map()

  const { data: lineup, error: lineupErr } = await supabase
    .from('weekly_lineups')
    .select('member_id, player_id')
    .in('member_id', memberIds)
    .eq('league_season_id', leagueSeasonId)
    .eq('week_number', weekNumber)
    .neq('slot_type', 'BE')
    .neq('slot_type', 'IR')

  if (lineupErr) throw lineupErr
  const lineupRows = (lineup ?? []) as LineupPlayer[]
  if (lineupRows.length === 0) return new Map(memberIds.map((id) => [id, 0]))

  const playerIds = [...new Set(lineupRows.map((r) => r.player_id))]

  const { data: stats, error: statsErr } = await supabase
    .from('player_game_stats')
    .select(
      'player_id,points,rebounds,assists,steals,blocks,turnovers,' +
        'three_pointers_made,field_goals_made,field_goals_attempted,' +
        'free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play',
    )
    .in('player_id', playerIds)
    .eq('season_year', seasonYear)
    .gte('game_date', weekStart)
    .lte('game_date', weekEnd)

  if (statsErr) throw statsErr

  const pointsByPlayer = new Map<string, number>()
  for (const stat of (stats ?? []) as unknown as StatRow[]) {
    pointsByPlayer.set(
      stat.player_id,
      (pointsByPlayer.get(stat.player_id) ?? 0) + calculateFantasyPoints(snakeToStatLine(stat), settings),
    )
  }

  const pointsByMember = new Map(memberIds.map((id) => [id, 0]))
  for (const row of lineupRows) {
    pointsByMember.set(
      row.member_id,
      (pointsByMember.get(row.member_id) ?? 0) + (pointsByPlayer.get(row.player_id) ?? 0),
    )
  }

  for (const [memberId, points] of pointsByMember) {
    pointsByMember.set(memberId, parseFloat(points.toFixed(2)))
  }

  return pointsByMember
}

async function calcWeekMaxPossiblePointsByMember(
  memberIds: string[],
  leagueSeasonId: string,
  seasonYear: number,
  weekNumber: number,
  settings: Record<string, number>,
  weekStart: string,
  weekEnd: string,
): Promise<Map<string, number>> {
  if (memberIds.length === 0) return new Map()

  const { data: lineup, error: lineupErr } = await supabase
    .from('weekly_lineups')
    .select('member_id, player_id, slot_type')
    .in('member_id', memberIds)
    .eq('league_season_id', leagueSeasonId)
    .eq('week_number', weekNumber)
    .neq('slot_type', 'IR')

  if (lineupErr) throw lineupErr
  const lineupRows = (lineup ?? []) as LineupSlot[]
  if (lineupRows.length === 0) return new Map(memberIds.map((id) => [id, 0]))

  const starterCounts = new Map(memberIds.map((id) => [id, 0]))
  for (const row of lineupRows) {
    if (row.slot_type !== 'BE') {
      starterCounts.set(row.member_id, (starterCounts.get(row.member_id) ?? 0) + 1)
    }
  }

  const playerIds = [...new Set(lineupRows.map((r) => r.player_id))]
  const { data: stats, error: statsErr } = await supabase
    .from('player_game_stats')
    .select(
      'player_id,points,rebounds,assists,steals,blocks,turnovers,' +
        'three_pointers_made,field_goals_made,field_goals_attempted,' +
        'free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play',
    )
    .in('player_id', playerIds)
    .eq('season_year', seasonYear)
    .gte('game_date', weekStart)
    .lte('game_date', weekEnd)

  if (statsErr) throw statsErr

  const pointsByPlayer = new Map<string, number>()
  for (const stat of (stats ?? []) as unknown as StatRow[]) {
    pointsByPlayer.set(
      stat.player_id,
      (pointsByPlayer.get(stat.player_id) ?? 0) + calculateFantasyPoints(snakeToStatLine(stat), settings),
    )
  }

  const playerScoresByMember = new Map(memberIds.map((id) => [id, [] as number[]]))
  for (const row of lineupRows) {
    playerScoresByMember.get(row.member_id)?.push(pointsByPlayer.get(row.player_id) ?? 0)
  }

  const maxPointsByMember = new Map<string, number>()
  for (const memberId of memberIds) {
    const starterCount = starterCounts.get(memberId) ?? 0
    const scores = [...(playerScoresByMember.get(memberId) ?? [])].sort((a, b) => b - a)
    const maxPoints = scores.slice(0, starterCount).reduce((sum, points) => sum + points, 0)
    maxPointsByMember.set(memberId, parseFloat(maxPoints.toFixed(2)))
  }

  return maxPointsByMember
}

async function insertStandingsSnapshots(
  leagueId: string,
  leagueSeasonId: string,
  weekNumber: number,
  matchups: MatchupForFinalization[],
  maxPossiblePointsByMember: Map<string, number>,
) {
  const memberIds = [
    ...new Set(matchups.flatMap((m) => [m.home_member_id, m.away_member_id])),
  ]
  if (memberIds.length === 0) return

  const { data: existingRows, error: existingErr } = await supabase
    .from('standings')
    .select('member_id')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('week_number', weekNumber)
    .in('member_id', memberIds)
  if (existingErr) throw existingErr
  const existingMembers = new Set((existingRows ?? []).map((row) => row.member_id))

  const { data: previousRows, error: previousErr } = await supabase
    .from('standings')
    .select('member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority, week_number')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .lt('week_number', weekNumber)
    .in('member_id', memberIds)
    .order('week_number', { ascending: false })
  if (previousErr) throw previousErr

  const previousByMember = new Map<string, StandingSnapshot>()
  for (const row of (previousRows ?? []) as StandingSnapshot[]) {
    if (!previousByMember.has(row.member_id)) previousByMember.set(row.member_id, row)
  }

  const { data: waiverRows, error: waiverErr } = await supabase
    .from('waiver_priorities')
    .select('member_id, priority')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .in('member_id', memberIds)
  if (waiverErr) throw waiverErr
  const waiverPriorityByMember = new Map((waiverRows ?? []).map((row) => [row.member_id, row.priority]))

  const standingsByMember = new Map<string, StandingSnapshot>()
  for (const memberId of memberIds) {
    const previous = previousByMember.get(memberId)
    standingsByMember.set(memberId, {
      member_id: memberId,
      wins: previous?.wins ?? 0,
      losses: previous?.losses ?? 0,
      ties: previous?.ties ?? 0,
      points_for: Number(previous?.points_for ?? 0),
      points_against: Number(previous?.points_against ?? 0),
      max_possible_points: Number(previous?.max_possible_points ?? 0),
      waiver_priority: waiverPriorityByMember.get(memberId) ?? previous?.waiver_priority ?? 0,
    })
  }

  for (const matchup of matchups) {
    const home = standingsByMember.get(matchup.home_member_id)
    const away = standingsByMember.get(matchup.away_member_id)
    if (!home || !away) continue

    const homePoints = Number(matchup.home_points ?? 0)
    const awayPoints = Number(matchup.away_points ?? 0)
    home.points_for += homePoints
    home.points_against += awayPoints
    home.max_possible_points += maxPossiblePointsByMember.get(matchup.home_member_id) ?? 0
    away.points_for += awayPoints
    away.points_against += homePoints
    away.max_possible_points += maxPossiblePointsByMember.get(matchup.away_member_id) ?? 0

    if (homePoints > awayPoints) {
      home.wins += 1
      away.losses += 1
    } else if (awayPoints > homePoints) {
      away.wins += 1
      home.losses += 1
    } else {
      home.ties += 1
      away.ties += 1
    }
  }

  const insertRows = [...standingsByMember.values()]
    .filter((row) => !existingMembers.has(row.member_id))
    .map((row) => ({
      league_id: leagueId,
      league_season_id: leagueSeasonId,
      member_id: row.member_id,
      week_number: weekNumber,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      points_for: parseFloat(row.points_for.toFixed(2)),
      points_against: parseFloat(row.points_against.toFixed(2)),
      max_possible_points: parseFloat(row.max_possible_points.toFixed(2)),
      waiver_priority: row.waiver_priority,
    }))

  if (insertRows.length === 0) return
  const { error: insertErr } = await supabase.from('standings').insert(insertRows)
  if (insertErr) throw insertErr
}

async function updateWeekPoints(
  leagueId: string,
  leagueSeasonId: string,
  seasonYear: number,
  weekNumber: number,
  settings: Record<string, number>,
) {
  const weekBounds = await getWeekBounds(seasonYear, weekNumber)
  if (!weekBounds) {
    console.log(`[sync-scores] No season_weeks row for week ${weekNumber}`)
    return
  }

  const { data: matchups, error: mErr } = await supabase
    .from('matchups')
    .select('id, league_id, league_season_id, week_number, home_member_id, away_member_id')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('week_number', weekNumber)
    .eq('is_finalized', false)
  if (mErr) throw mErr
  if (!matchups?.length) return

  const matchupRows = matchups as MatchupForScore[]
  const memberIds = [
    ...new Set(matchupRows.flatMap((m) => [m.home_member_id, m.away_member_id])),
  ]
  const pointsByMember = await calcWeekPointsByMember(
    memberIds,
    leagueSeasonId,
    seasonYear,
    weekNumber,
    settings,
    weekBounds.weekStart,
    weekBounds.weekEnd,
  )

  const updates = matchupRows.map((matchup) => ({
    id: matchup.id,
    league_id: matchup.league_id,
    league_season_id: matchup.league_season_id,
    week_number: matchup.week_number,
    home_member_id: matchup.home_member_id,
    away_member_id: matchup.away_member_id,
    home_points: pointsByMember.get(matchup.home_member_id) ?? 0,
    away_points: pointsByMember.get(matchup.away_member_id) ?? 0,
  }))

  const { error: updateErr } = await supabase
    .from('matchups')
    .upsert(updates, { onConflict: 'id' })
  if (updateErr) throw updateErr
}

async function finalizeWeekIfComplete(
  leagueId: string,
  leagueSeasonId: string,
  weekNumber: number,
  seasonYear: number,
  settings: Record<string, number>,
) {
  const weekBounds = await getWeekBounds(seasonYear, weekNumber)
  if (!weekBounds) return

  const { count: pendingGames } = await supabase
    .from('nba_games')
    .select('id', { count: 'exact', head: true })
    .eq('season_year', seasonYear)
    .gte('game_date', weekBounds.weekStart)
    .lte('game_date', weekBounds.weekEnd)
    .in('status', ['Scheduled', 'InProgress'])

  if ((pendingGames ?? 0) > 0) return

  const { data: matchups } = await supabase
    .from('matchups')
    .select('id, home_member_id, away_member_id, home_points, away_points')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .eq('week_number', weekNumber)
    .eq('is_finalized', false)

  if (!matchups?.length) return

  const matchupRows = matchups as MatchupForFinalization[]
  const memberIds = [
    ...new Set(matchupRows.flatMap((m) => [m.home_member_id, m.away_member_id])),
  ]
  const maxPossiblePointsByMember = await calcWeekMaxPossiblePointsByMember(
    memberIds,
    leagueSeasonId,
    seasonYear,
    weekNumber,
    settings,
    weekBounds.weekStart,
    weekBounds.weekEnd,
  )

  await insertStandingsSnapshots(
    leagueId,
    leagueSeasonId,
    weekNumber,
    matchupRows,
    maxPossiblePointsByMember,
  )

  for (const m of matchupRows) {
    const homePoints = Number(m.home_points ?? 0)
    const awayPoints = Number(m.away_points ?? 0)
    const winnerId =
      homePoints === awayPoints
        ? null
        : homePoints > awayPoints
          ? m.home_member_id
          : m.away_member_id

    await supabase.from('matchups').update({
      home_max_possible_points: maxPossiblePointsByMember.get(m.home_member_id) ?? 0,
      away_max_possible_points: maxPossiblePointsByMember.get(m.away_member_id) ?? 0,
      winner_member_id: winnerId,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    }).eq('id', m.id)

    if (winnerId === null) {
      const tiePts = homePoints.toFixed(1)
      await Promise.all([
        notifyMember(m.home_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
        notifyMember(m.away_member_id, `Week ${weekNumber} Final`, `You tied ${tiePts}–${tiePts}.`),
      ]).catch(console.error)
    } else {
      const loserId = winnerId === m.home_member_id ? m.away_member_id : m.home_member_id
      const winnerPts = Math.max(homePoints, awayPoints).toFixed(1)
      const loserPts = Math.min(homePoints, awayPoints).toFixed(1)
      await Promise.all([
        notifyMember(winnerId, `Week ${weekNumber} Final`, `You won ${winnerPts}–${loserPts}! 🏆`),
        notifyMember(loserId, `Week ${weekNumber} Final`, `You lost ${loserPts}–${winnerPts}.`),
      ]).catch(console.error)
    }
  }

  console.log(`[sync-scores] Finalized week ${weekNumber} for league ${leagueId}`)
}
