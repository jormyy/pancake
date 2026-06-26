import { supabase } from './supabase.ts'
import { buildStatRow } from './syncStats.ts'
import { errorMessage } from './responses.ts'
import {
  completeBackfillJobFromLedger,
  failBackfillJob,
  invokeBackfill,
  loadBackfillTerminalGameKeys,
  markBackfillGameCompleted,
  markBackfillGameFailed,
  markBackfillGameMissing,
  mustSupabase,
  syncBackfillLedgerProgress,
  updateBackfillJob,
} from './backfillJobs.ts'
import { loadCdnPlayerResolver, persistNbaIdUpdates, resolveCdnPlayer } from './playerResolver.ts'
import type { Database } from './database.ts'
import type { NBABoxScorePlayer } from './nba.ts'

type PlayerGameStatInsert = Database['public']['Tables']['player_game_stats']['Insert']

const NBA_CDN_BASE_URL = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
const CDN_CHUNK = 30
const CDN_DELAY_MS = 200
const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
}

type DbGame = {
  id: string
  nba_game_id: string
  week_number: number
}

type CdnGame = {
  gameStatus?: number
  gameEt?: string
  homeTeam?: { teamTricode?: string; players?: NBABoxScorePlayer[] }
  awayTeam?: { teamTricode?: string; players?: NBABoxScorePlayer[] }
}

type CdnBoxScore = {
  game?: CdnGame
}

export async function runCDNChunk(seasonYear: number, jobId: string, offset: number): Promise<void> {
  const allGames = await loadFinalCdnGames(seasonYear)
  const terminalGameKeys = await loadBackfillTerminalGameKeys(jobId, 'cdn')
  const pending = allGames.filter((game) => !terminalGameKeys.has(game.nba_game_id))

  if (offset === 0) await updateBackfillJob(jobId, { total_items: allGames.length })

  const chunk = pending.slice(0, CDN_CHUNK)
  if (!chunk.length) {
    await completeBackfillJobFromLedger(jobId, 'cdn')
    console.log(`[backfill/cdn] Season ${seasonYear} complete.`)
    return
  }

  let completed = 0
  let failed = 0

  for (const dbGame of chunk) {
    const gameId = dbGame.nba_game_id
    try {
      const resolver = await loadCdnPlayerResolver()
      const game = await fetchCdnGame(gameId)
      if (!game || game.gameStatus !== 3) {
        await markBackfillGameFailed(jobId, 'cdn', seasonYear, gameId, 'CDN game is not final', dbGame.id)
        failed++
        continue
      }

      await upsertCdnStats(game, dbGame.id, seasonYear, dbGame.week_number, resolver)
      await persistNbaIdUpdates(resolver.nbaIdUpdates)
      await markBackfillGameCompleted(jobId, 'cdn', seasonYear, gameId, dbGame.id)
      completed++
    } catch (e) {
      await markBackfillGameFailed(jobId, 'cdn', seasonYear, gameId, e, dbGame.id)
      failed++
      console.warn(`[backfill/cdn] ${gameId}: ${errorMessage(e)}`)
    }

    await delay(CDN_DELAY_MS)
  }

  const isDone = pending.length <= CDN_CHUNK
  const ledgerProgress = await syncBackfillLedgerProgress(jobId, 'cdn', isDone)

  if (!isDone) {
    try {
      await invokeBackfill({ action: 'continue', source: 'cdn', seasonYear, jobId, offset: offset + CDN_CHUNK })
    } catch (e) {
      await failBackfillJob(jobId, e)
      throw e
    }
  }

  console.log(`[backfill/cdn] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed, ${Math.max(0, pending.length - CDN_CHUNK)} remaining; ledger=${ledgerProgress.completed_items}/${ledgerProgress.failed_items}`)
}

export async function runCDNEnumChunk(seasonYear: number, jobId: string, offset: number): Promise<void> {
  const allGameIds = buildCandidateGameIds(seasonYear)
  const terminalGameKeys = await loadBackfillTerminalGameKeys(jobId, 'cdn-enum')
  const chunk = allGameIds.slice(offset, offset + CDN_CHUNK)
  if (!chunk.length) {
    await completeBackfillJobFromLedger(jobId, 'cdn-enum')
    return
  }

  let completed = 0
  let failed = 0
  let missing = 0
  let consecutiveMisses = 0
  let done = false
  let nextOffset = offset + CDN_CHUNK

  for (let index = 0; index < chunk.length; index++) {
    const gameId = chunk[index]
    const currentOffset = offset + index
    if (terminalGameKeys.has(gameId)) continue

    try {
      const resolver = await loadCdnPlayerResolver()
      const result = await fetchCdnGameOrMiss(gameId)
      if (result === 'missing') {
        await markBackfillGameMissing(jobId, 'cdn-enum', seasonYear, gameId)
        missing++
        consecutiveMisses++
        if (consecutiveMisses > 25) {
          const nextRangeOffset = findNextCandidateRangeOffset(allGameIds, currentOffset)
          if (nextRangeOffset == null) {
            done = true
          } else {
            nextOffset = nextRangeOffset
          }
          break
        }
        await delay(CDN_DELAY_MS)
        continue
      }

      consecutiveMisses = 0
      const game = result
      if (!game || game.gameStatus !== 3) {
        await markBackfillGameFailed(jobId, 'cdn-enum', seasonYear, gameId, 'CDN game is not final')
        failed++
        await delay(CDN_DELAY_MS)
        continue
      }

      const dbGame = await upsertCdnGame(gameId, game, seasonYear)
      await upsertCdnStats(game, dbGame.id, seasonYear, dbGame.week_number, resolver)
      await persistNbaIdUpdates(resolver.nbaIdUpdates)
      await markBackfillGameCompleted(jobId, 'cdn-enum', seasonYear, gameId, dbGame.id)
      completed++
    } catch (e) {
      await markBackfillGameFailed(jobId, 'cdn-enum', seasonYear, gameId, e)
      failed++
      console.warn(`[backfill/cdn-enum] ${gameId}: ${errorMessage(e)}`)
    }
    await delay(CDN_DELAY_MS)
  }

  const isDone = done || nextOffset >= allGameIds.length
  if (isDone) await recalcCdnEnumWeekNumbers(seasonYear)
  const ledgerProgress = await syncBackfillLedgerProgress(jobId, 'cdn-enum', isDone)

  if (!isDone) {
    try {
      await invokeBackfill({ action: 'continue', source: 'cdn-enum', seasonYear, jobId, offset: nextOffset })
    } catch (e) {
      await failBackfillJob(jobId, e)
      throw e
    }
  }

  console.log(`[backfill/cdn-enum] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed, ${missing} missing; ledger=${ledgerProgress.completed_items}/${ledgerProgress.failed_items}/${ledgerProgress.missing_items}`)
}

async function loadFinalCdnGames(seasonYear: number): Promise<DbGame[]> {
  const games: DbGame[] = []
  let page = 0
  while (true) {
    const rows = await mustSupabase(
      'load final CDN games',
      supabase
        .from('nba_games')
        .select('id, nba_game_id, week_number')
        .eq('season_year', seasonYear)
        .eq('status', 'Final')
        .like('nba_game_id', '002%')
        .order('game_date', { ascending: true })
        .range(page * 1000, (page + 1) * 1000 - 1),
    )
    if (!rows?.length) break
    games.push(...rows as DbGame[])
    if (rows.length < 1000) break
    page++
  }
  return games
}

async function loadCdnSeasonGames(seasonYear: number): Promise<Array<{ id: string; nba_game_id: string; game_date: string }>> {
  const games: Array<{ id: string; nba_game_id: string; game_date: string }> = []
  let page = 0
  while (true) {
    const rows = await mustSupabase(
      'load CDN season games for week repair',
      supabase
        .from('nba_games')
        .select('id, nba_game_id, game_date')
        .eq('season_year', seasonYear)
        .eq('status', 'Final')
        .like('nba_game_id', '002%')
        .order('game_date', { ascending: true })
        .range(page * 1000, (page + 1) * 1000 - 1),
    )
    if (!rows?.length) break
    games.push(...rows as Array<{ id: string; nba_game_id: string; game_date: string }>)
    if (rows.length < 1000) break
    page++
  }
  return games
}

async function fetchCdnGame(gameId: string): Promise<CdnGame | null> {
  const result = await fetchCdnGameOrMiss(gameId)
  if (result === 'missing') throw new Error('CDN missing')
  return result
}

async function fetchCdnGameOrMiss(gameId: string): Promise<CdnGame | 'missing' | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const res = await fetch(
    `${NBA_CDN_BASE_URL}/liveData/boxscore/boxscore_${gameId}.json`,
    { headers: CDN_HEADERS, signal: controller.signal },
  ).finally(() => clearTimeout(timeout))

  if (res.status === 404 || res.status === 403) return 'missing'
  if (!res.ok) throw new Error(`CDN ${res.status}`)

  const data = await res.json() as CdnBoxScore
  return data.game ?? null
}

async function upsertCdnStats(
  game: CdnGame,
  dbGameId: string,
  seasonYear: number,
  weekNumber: number,
  resolver: Awaited<ReturnType<typeof loadCdnPlayerResolver>>,
): Promise<void> {
  const stats: PlayerGameStatInsert[] = []
  const allPlayers = [
    ...(game.homeTeam?.players ?? []),
    ...(game.awayTeam?.players ?? []),
  ]

  for (const player of allPlayers) {
    if (!player.statistics) continue
    const personId = String(player.personId)
    const name = player.name ?? ''
    const playerId = await resolveCdnPlayer(resolver, personId, name)
    if (!playerId) continue
    stats.push(buildStatRow(player, playerId, dbGameId, seasonYear, weekNumber) as PlayerGameStatInsert)
  }

  if (!stats.length) throw new Error('No CDN player stats parsed from final box score')

  await mustSupabase(
    'upsert CDN player game stats',
    supabase.from('player_game_stats').upsert(stats, { onConflict: 'player_id,game_id' }),
  )
}

async function upsertCdnGame(gameId: string, game: CdnGame, seasonYear: number): Promise<DbGame> {
  const gameDate = game.gameEt?.split('T')[0]
  const homeTeam = game.homeTeam?.teamTricode ?? ''
  const awayTeam = game.awayTeam?.teamTricode ?? ''
  if (!gameDate || !homeTeam || !awayTeam) throw new Error(`CDN game ${gameId} is missing date or teams`)
  const weekNumber = estimateCdnWeekNumber(seasonYear, gameDate)

  await mustSupabase(
    'upsert CDN game',
    supabase.from('nba_games').upsert({
      nba_game_id: gameId,
      season_year: seasonYear,
      game_date: gameDate,
      home_team: homeTeam,
      away_team: awayTeam,
      status: 'Final',
      week_number: weekNumber,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'nba_game_id' }),
  )

  const dbGame = await mustSupabase(
    'load upserted CDN game',
    supabase
      .from('nba_games')
      .select('id, nba_game_id, week_number')
      .eq('nba_game_id', gameId)
      .single(),
  )
  return dbGame as DbGame
}

function estimateCdnWeekNumber(seasonYear: number, gameDate: string): number {
  const seasonStart = `${seasonYear - 1}-10-15`
  const daysDiff = Math.floor((new Date(gameDate).getTime() - new Date(seasonStart).getTime()) / 86_400_000)
  return Math.max(1, Math.floor(daysDiff / 7) + 1)
}

function buildCandidateGameIds(seasonYear: number): string[] {
  const yy = String(seasonYear - 2001).padStart(2, '0')
  const gameIds: string[] = []
  for (let n = 1; n <= 1300; n++) gameIds.push(`002${yy}0${String(n).padStart(4, '0')}`)
  return gameIds
}

function findNextCandidateRangeOffset(gameIds: string[], currentOffset: number): number | null {
  const currentPrefix = gameIds[currentOffset]?.slice(0, 3)
  if (!currentPrefix) return null

  for (let index = currentOffset + 1; index < gameIds.length; index++) {
    if (gameIds[index].slice(0, 3) !== currentPrefix) return index
  }

  return null
}

async function recalcCdnEnumWeekNumbers(seasonYear: number): Promise<void> {
  const games = await loadCdnSeasonGames(seasonYear)
  if (!games.length) return

  const dateCounts = new Map<string, number>()
  for (const game of games) dateCounts.set(game.game_date, (dateCounts.get(game.game_date) ?? 0) + 1)

  const bulkStart = [...dateCounts.entries()].filter(([, count]) => count >= 5).map(([date]) => date).sort()[0]
  const seasonStart = bulkStart ?? games.map((game) => game.game_date).sort()[0]
  const startMs = new Date(seasonStart).getTime()
  const weekMap: Record<number, { start: string; end: string; gameIds: string[]; dbGameIds: string[] }> = {}

  for (const game of games) {
    const daysDiff = Math.floor((new Date(game.game_date).getTime() - startMs) / 86_400_000)
    const weekNumber = Math.max(1, Math.floor(daysDiff / 7) + 1)
    const range = weekMap[weekNumber] ?? { start: game.game_date, end: game.game_date, gameIds: [], dbGameIds: [] }
    if (game.game_date < range.start) range.start = game.game_date
    if (game.game_date > range.end) range.end = game.game_date
    range.gameIds.push(game.nba_game_id)
    range.dbGameIds.push(game.id)
    weekMap[weekNumber] = range
  }

  for (const [weekNumberText, range] of Object.entries(weekMap)) {
    const weekNumber = parseInt(weekNumberText)
    for (let i = 0; i < range.gameIds.length; i += 500) {
      await mustSupabase(
        'repair CDN enum game week numbers',
        supabase
          .from('nba_games')
          .update({ week_number: weekNumber })
          .in('nba_game_id', range.gameIds.slice(i, i + 500)),
      )
    }
    for (let i = 0; i < range.dbGameIds.length; i += 500) {
      await mustSupabase(
        'repair CDN enum stat week numbers',
        supabase
          .from('player_game_stats')
          .update({ week_number: weekNumber })
          .in('game_id', range.dbGameIds.slice(i, i + 500)),
      )
    }
  }

  const weeks = Object.entries(weekMap).map(([weekNumber, range]) => ({
    season_year: seasonYear,
    week_number: parseInt(weekNumber),
    week_start: range.start,
    week_end: range.end,
  }))
  await mustSupabase(
    'repair CDN enum season weeks',
    supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' }),
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
