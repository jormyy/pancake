import { supabase } from './supabase.ts'
import { fetchBBRefSchedule, fetchBBRefBoxScore, sleep } from './bbref.ts'
import { errorMessage } from './responses.ts'
import {
  completeBackfillJobFromLedger,
  failBackfillJob,
  invokeBackfill,
  loadBackfillTerminalGameKeys,
  markBackfillGameCompleted,
  markBackfillGameFailed,
  mustSupabase,
  syncBackfillLedgerProgress,
  updateBackfillJob,
} from './backfillJobs.ts'
import { loadNamePlayerResolver, resolveNamedPlayer } from './playerResolver.ts'

const BBREF_CHUNK = 40
const PAGE_SIZE = 1000

type DbGame = {
  id: string
  nba_game_id: string
  bbref_home_team: string | null
  bbref_away_team: string | null
  week_number: number
}

type GameRecord = {
  nba_game_id: string
  bbref_home_team: string
  bbref_away_team: string
  season_year: number
  game_date: string
  home_team: string
  away_team: string
  status: 'Final'
  week_number: number
  updated_at: string
}

export async function runBBRefChunk(seasonYear: number, jobId: string, offset: number): Promise<void> {
  const resolver = await loadNamePlayerResolver()

  if (offset === 0) {
    const initialized = await initializeBBRefSeason(seasonYear, jobId)
    if (!initialized) return
  }

  const dbGames = await loadSeasonGames(seasonYear)
  const dbGameMap = new Map(dbGames.map((game) => [game.nba_game_id, game]))
  const terminalGameKeys = await loadBackfillTerminalGameKeys(jobId, 'bbref')
  const pendingGameIds = dbGames
    .map((game) => game.nba_game_id)
    .filter((id) => {
      const dbGame = dbGameMap.get(id)
      return dbGame && !terminalGameKeys.has(id)
    })

  if (offset === 0) await updateBackfillJob(jobId, { total_items: pendingGameIds.length })

  const chunkGameIds = pendingGameIds.slice(0, BBREF_CHUNK)
  if (!chunkGameIds.length) {
    await completeBackfillJobFromLedger(jobId, 'bbref')
    console.log(`[backfill/bbref] Season ${seasonYear} complete.`)
    return
  }

  let completed = 0
  let failed = 0

  for (const gameId of chunkGameIds) {
    const dbGame = dbGameMap.get(gameId)
    if (!dbGame) continue

    try {
      await upsertBBRefStats(gameId, dbGame, seasonYear, resolver)
      await markBackfillGameCompleted(jobId, 'bbref', seasonYear, gameId, dbGame.id)
      completed++
    } catch (e) {
      await markBackfillGameFailed(jobId, 'bbref', seasonYear, gameId, e, dbGame.id)
      failed++
      console.warn(`[backfill/bbref] ${gameId}: ${errorMessage(e)}`)
    }

    await sleep(3000)
  }

  const isDone = pendingGameIds.length <= BBREF_CHUNK
  const ledgerProgress = await syncBackfillLedgerProgress(jobId, 'bbref', isDone)

  if (!isDone) {
    try {
      await invokeBackfill({ action: 'continue', source: 'bbref', seasonYear, jobId, offset: offset + BBREF_CHUNK })
    } catch (e) {
      await failBackfillJob(jobId, e)
      throw e
    }
  }

  console.log(`[backfill/bbref] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed; ledger=${ledgerProgress.completed_items}/${ledgerProgress.failed_items}`)
}

async function initializeBBRefSeason(seasonYear: number, jobId: string): Promise<boolean> {
  console.log(`[backfill/bbref] Scraping schedule for ${seasonYear}...`)
  const scheduleGames = await fetchBBRefSchedule(seasonYear)

  if (!scheduleGames.length) {
    throw new Error(`BBRef schedule for ${seasonYear} returned zero games`)
  }

  const gameRecords = buildGameRecords(scheduleGames, seasonYear)

  for (let i = 0; i < gameRecords.length; i += 500) {
    const chunk = gameRecords.slice(i, i + 500)
    await mustSupabase(
      'upsert BBRef schedule games',
      supabase.from('nba_games').upsert(chunk, { onConflict: 'nba_game_id' }),
    )
  }

  const weeks = buildSeasonWeeks(gameRecords, seasonYear)
  await mustSupabase(
    'upsert BBRef season weeks',
    supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' }),
  )

  await updateBackfillJob(jobId, {
    total_items: scheduleGames.length,
    metadata: { source: 'bbref', seasonYear, phase: 'boxscores' },
  })

  return true
}

function buildGameRecords(
  scheduleGames: Awaited<ReturnType<typeof fetchBBRefSchedule>>,
  seasonYear: number,
): GameRecord[] {
  const dateCounts = new Map<string, number>()
  for (const game of scheduleGames) dateCounts.set(game.gameDate, (dateCounts.get(game.gameDate) ?? 0) + 1)
  const bulkStart = [...dateCounts.entries()].filter(([, count]) => count >= 5).map(([date]) => date).sort()[0]
  const seasonStart = bulkStart ?? scheduleGames.map((game) => game.gameDate).sort()[0]
  const startMs = new Date(seasonStart).getTime()
  const weekNumber = (date: string) => Math.max(1, Math.floor((new Date(date).getTime() - startMs) / 86_400_000 / 7) + 1)

  return scheduleGames.map((game) => ({
    nba_game_id: game.bbrefId,
    bbref_home_team: game.homeTeamBBRef,
    bbref_away_team: game.awayTeamBBRef,
    season_year: seasonYear,
    game_date: game.gameDate,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    status: 'Final',
    week_number: weekNumber(game.gameDate),
    updated_at: new Date().toISOString(),
  }))
}

function buildSeasonWeeks(gameRecords: GameRecord[], seasonYear: number) {
  const weekMap: Record<number, { start: string; end: string }> = {}
  for (const game of gameRecords) {
    const range = weekMap[game.week_number] ?? { start: game.game_date, end: game.game_date }
    if (game.game_date < range.start) range.start = game.game_date
    if (game.game_date > range.end) range.end = game.game_date
    weekMap[game.week_number] = range
  }

  return Object.entries(weekMap).map(([weekNumber, range]) => ({
    season_year: seasonYear,
    week_number: parseInt(weekNumber),
    week_start: range.start,
    week_end: range.end,
  }))
}

async function loadSeasonGames(seasonYear: number): Promise<DbGame[]> {
  const games: DbGame[] = []
  let page = 0
  while (true) {
    const rows = await mustSupabase(
      'load BBRef season games',
      supabase
        .from('nba_games')
        .select('id, nba_game_id, bbref_home_team, bbref_away_team, week_number')
        .eq('season_year', seasonYear)
        .order('game_date', { ascending: true })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
    )
    if (!rows?.length) break
    games.push(...rows as DbGame[])
    if (rows.length < PAGE_SIZE) break
    page++
  }
  return games
}

async function upsertBBRefStats(
  gameId: string,
  dbGame: DbGame,
  seasonYear: number,
  resolver: Awaited<ReturnType<typeof loadNamePlayerResolver>>,
): Promise<void> {
  const homeTeamBBRef = dbGame.bbref_home_team ?? gameId.substring(9)
  const awayTeamBBRef = dbGame.bbref_away_team
  if (!homeTeamBBRef || !awayTeamBBRef) {
    throw new Error(`BBRef team codes missing for ${gameId}`)
  }

  const boxScore = await fetchBBRefBoxScore(gameId, homeTeamBBRef, awayTeamBBRef)
  const stats = []

  for (const stat of [...boxScore.home, ...boxScore.away]) {
    const playerId = await resolveNamedPlayer(resolver, stat.playerName)
    if (!playerId) continue

    const minutesPlayed = stat.minutesDecimal
    const didNotPlay = stat.dnp || !minutesPlayed || minutesPlayed < 0.5
    const doubleDoubleStats = [stat.pts, stat.reb, stat.ast, stat.stl, stat.blk].filter((value) => value >= 10).length

    stats.push({
      player_id: playerId,
      game_id: dbGame.id,
      season_year: seasonYear,
      week_number: dbGame.week_number,
      minutes_played: minutesPlayed,
      points: stat.pts,
      rebounds: stat.reb,
      offensive_rebounds: stat.orb,
      defensive_rebounds: stat.drb,
      assists: stat.ast,
      steals: stat.stl,
      blocks: stat.blk,
      turnovers: stat.tov,
      personal_fouls: stat.pf,
      field_goals_made: stat.fgm,
      field_goals_attempted: stat.fga,
      three_pointers_made: stat.tpm,
      three_pointers_attempted: stat.tpa,
      free_throws_made: stat.ftm,
      free_throws_attempted: stat.fta,
      plus_minus: stat.plusMinus,
      double_double: doubleDoubleStats >= 2,
      triple_double: doubleDoubleStats >= 3,
      did_not_play: didNotPlay,
      updated_at: new Date().toISOString(),
    })
  }

  if (stats.length) {
    await mustSupabase(
      'upsert BBRef player game stats',
      supabase.from('player_game_stats').upsert(stats, { onConflict: 'player_id,game_id' }),
    )
  }
}
