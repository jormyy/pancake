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

type StatRow = Record<string, unknown> & {
  player_id: string
}

export async function syncScores() {
  const { data: seasons, error: sErr } = await supabase
    .from('league_seasons')
    .select('id, league_id, season_year, leagues ( scoring_settings, playoff_start_week )')
    .eq('is_current', true)
  if (sErr) throw sErr
  if (!seasons?.length) return

  for (const season of seasons) {
    const league = season.leagues as any
    const settings: Record<string, number> = league?.scoring_settings ?? {}
    const playoffStart: number = league?.playoff_start_week ?? 20
    const regularSeasonWeeks = playoffStart - 1

    const weekNumber = await getWeekNumberForDate(new Date(), season.season_year)
    if (!weekNumber) {
      console.log(`[sync-scores] No current week for season ${season.season_year}`)
      continue
    }
    if (weekNumber > regularSeasonWeeks) {
      console.log(`[sync-scores] Week ${weekNumber} is in playoffs — skipping`)
      continue
    }

    await updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber, settings)
    if (weekNumber > 1) {
      await updateWeekPoints(season.league_id, season.id, season.season_year, weekNumber - 1, settings)
    }

    await finalizeWeekIfComplete(season.league_id, season.id, weekNumber, season.season_year)
    if (weekNumber > 1) await finalizeWeekIfComplete(season.league_id, season.id, weekNumber - 1, season.season_year)
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

  for (const m of matchups) {
    const homePoints = Number(m.home_points ?? 0)
    const awayPoints = Number(m.away_points ?? 0)
    const winnerId = homePoints >= awayPoints ? m.home_member_id : m.away_member_id

    await supabase.from('matchups').update({
      winner_member_id: winnerId,
      is_finalized: true,
      finalized_at: new Date().toISOString(),
    }).eq('id', m.id)

    const loserId = winnerId === m.home_member_id ? m.away_member_id : m.home_member_id
    const winnerPts = Math.max(homePoints, awayPoints).toFixed(1)
    const loserPts = Math.min(homePoints, awayPoints).toFixed(1)
    await Promise.all([
      notifyMember(winnerId, `Week ${weekNumber} Final`, `You won ${winnerPts}–${loserPts}! 🏆`),
      notifyMember(loserId, `Week ${weekNumber} Final`, `You lost ${loserPts}–${winnerPts}.`),
    ]).catch(console.error)
  }

  console.log(`[sync-scores] Finalized week ${weekNumber} for league ${leagueId}`)
}
