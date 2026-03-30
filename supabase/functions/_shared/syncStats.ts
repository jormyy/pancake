import { supabase } from './supabase.ts'
import { fetchBoxScore, parseNBAMinutes, NBABoxScorePlayer } from './nba.ts'

export async function syncStatsByDate(date: Date) {
  const dateStr = date.toISOString().split('T')[0]
  console.log(`[sync-stats] Fetching stats for ${dateStr}...`)

  const { data: games, error: gErr } = await supabase
    .from('nba_games')
    .select('id, nba_game_id, week_number, season_year, status')
    .eq('game_date', dateStr)
    .not('nba_game_id', 'is', null)
    .neq('status', 'Scheduled')

  if (gErr) throw gErr
  if (!games?.length) {
    console.log(`[sync-stats] No completed/live games for ${dateStr}.`)
    return
  }

  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('id, display_name, nba_id')
    .limit(10000)
  if (pErr) throw pErr

  const byNbaId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const p of players ?? []) {
    if (p.nba_id) byNbaId.set(p.nba_id, p.id)
    byName.set(p.display_name.toLowerCase(), p.id)
  }

  let statCount = 0
  const nbaIdUpdates: { id: string; nba_id: string }[] = []

  for (const game of games) {
    try {
      const boxScore = await fetchBoxScore(game.nba_game_id!)
      const allPlayers = [
        ...(boxScore.homeTeam?.players ?? []),
        ...(boxScore.awayTeam?.players ?? []),
      ]

      const stats: any[] = []

      for (const p of allPlayers) {
        const personId = String(p.personId)
        let playerId = byNbaId.get(personId)

        if (!playerId) {
          const nameLower = (p.name ?? '').toLowerCase()
          playerId = byName.get(nameLower)
          if (playerId && !byNbaId.has(personId)) {
            nbaIdUpdates.push({ id: playerId, nba_id: personId })
            byNbaId.set(personId, playerId)
          }
        }

        if (!playerId) continue
        if (!p.statistics) continue

        stats.push(buildStatRow(p, playerId, game.id, game.season_year, game.week_number))
      }

      if (stats.length) {
        const { error } = await supabase
          .from('player_game_stats')
          .upsert(stats, { onConflict: 'player_id,game_id' })
        if (error) throw error
        statCount += stats.length
      }
    } catch (e: any) {
      console.error(`[sync-stats] Error for ${game.nba_game_id}:`, e.message)
    }
  }

  for (const u of nbaIdUpdates) {
    await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
  }
  if (nbaIdUpdates.length > 0) {
    console.log(`[sync-stats] Mapped ${nbaIdUpdates.length} new NBA person IDs.`)
  }

  console.log(`[sync-stats] Upserted ${statCount} stat lines for ${dateStr}.`)
}

export function buildStatRow(
  p: NBABoxScorePlayer,
  playerId: string,
  gameId: string,
  seasonYear: number,
  weekNumber: number | null,
): Record<string, unknown> {
  const s = p.statistics
  const minutesPlayed = parseNBAMinutes(s.minutes)
  const dnp = !minutesPlayed || minutesPlayed < 0.5

  const reb = s.reboundsTotal ?? 0
  const ast = s.assists ?? 0
  const pts = s.points ?? 0
  const stl = s.steals ?? 0
  const blk = s.blocks ?? 0

  const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length

  return {
    player_id: playerId,
    game_id: gameId,
    season_year: seasonYear,
    week_number: weekNumber,
    minutes_played: minutesPlayed,
    points: pts,
    rebounds: reb,
    offensive_rebounds: s.reboundsOffensive ?? null,
    defensive_rebounds: s.reboundsDefensive ?? null,
    assists: ast,
    steals: stl,
    blocks: blk,
    turnovers: s.turnovers ?? null,
    personal_fouls: s.foulsPersonal ?? null,
    field_goals_made: s.fieldGoalsMade ?? null,
    field_goals_attempted: s.fieldGoalsAttempted ?? null,
    three_pointers_made: s.threePointersMade ?? null,
    three_pointers_attempted: s.threePointersAttempted ?? null,
    free_throws_made: s.freeThrowsMade ?? null,
    free_throws_attempted: s.freeThrowsAttempted ?? null,
    plus_minus: s.plusMinusPoints ?? null,
    double_double: statCats >= 2,
    triple_double: statCats >= 3,
    did_not_play: dnp,
    updated_at: new Date().toISOString(),
  }
}
