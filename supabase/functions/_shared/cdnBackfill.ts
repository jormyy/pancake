import { assertGameImports, assertGameUnambiguous } from './gameIdentity.ts'
import { supabase } from './supabase.ts'
import { buildStatRow, resolveBoxScorePlayers, saveGameStats, validateBoxScorePlayers } from './syncStats.ts'
import { errorMessage } from './responses.ts'
import {
  type BackfillRun,
  completeBackfillJobFromLedger,
  failBackfillJob,
  invokeBackfill,
  loadBackfillRetryGameKeys,
  loadBackfillTerminalGameKeys,
  markBackfillGameCompleted,
  markBackfillGameFailed,
  markBackfillGameMissing,
  mustSupabase,
  syncBackfillLedgerProgress,
  updateBackfillJob,
} from './backfillJobs.ts'
import { loadCdnPlayerResolver } from './playerResolver.ts'
import type { NBABoxScorePlayer } from './nba.ts'


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

/** Returns true when the next chunk was queued with this run's claim. */
export async function runCDNChunk(run: BackfillRun, offset: number): Promise<boolean> {
  const { jobId, seasonYear } = run
  const allGames = await loadFinalCdnGames(seasonYear)
  const terminalGameKeys = await loadBackfillTerminalGameKeys(jobId, 'cdn')
  const retryGameKeys = run.retryBefore ? await loadBackfillRetryGameKeys(run) : null
  const pending = allGames.filter((game) =>
    !terminalGameKeys.has(game.nba_game_id) || retryGameKeys?.has(game.nba_game_id))

  if (offset === 0) await updateBackfillJob(jobId, { total_items: allGames.length })

  const chunk = pending.slice(0, CDN_CHUNK)
  if (!chunk.length) {
    await completeBackfillJobFromLedger(jobId, 'cdn')
    console.log(`[backfill/cdn] Season ${seasonYear} complete.`)
    return false
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

      await assertGameUnambiguous(dbGame.id)
      const players = await resolveBoxScorePlayers(game, gameId, resolver)
      await upsertCdnStats(players, dbGame.id, gameId, seasonYear, dbGame.week_number)
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
      await invokeBackfill({ action: 'continue', source: 'cdn', seasonYear, jobId, offset: offset + CDN_CHUNK, claimToken: run.claimToken })
    } catch (e) {
      await failBackfillJob(jobId, e)
      throw e
    }
  }

  console.log(`[backfill/cdn] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed, ${Math.max(0, pending.length - CDN_CHUNK)} remaining; ledger=${ledgerProgress.completed_items}/${ledgerProgress.failed_items}`)
  return !isDone
}

/** Returns true when the next chunk was queued with this run's claim. */
export async function runCDNEnumChunk(run: BackfillRun, offset: number): Promise<boolean> {
  const allGameIds = buildCandidateGameIds(run.seasonYear)
  const terminal = await loadBackfillTerminalGameKeys(run.jobId, 'cdn-enum')
  const missing = await loadBackfillTerminalGameKeys(run.jobId, 'cdn-enum', ['missing'])
  const retry = run.retryBefore ? await loadBackfillRetryGameKeys(run) : new Set<string>()
  const counts = { completed: 0, failed: 0, missing: 0 }
  let attempted = 0

  // Keep explicit retries even if an earlier missing tail ends ordinary discovery.
  const retryIds = allGameIds.filter((id) => retry.has(id))
  for (const gameId of retryIds.slice(0, CDN_CHUNK)) {
    const outcome = await processCdnEnumGame(run, gameId)
    counts[outcome]++
    attempted++
    terminal.add(gameId)
    if (outcome === 'missing') missing.add(gameId)
    await delay(CDN_DELAY_MS)
  }
  if (retryIds.length > CDN_CHUNK) {
    return await finishCdnEnumChunk(run, offset, 0, false, counts)
  }

  // Reconstruct the missing tail from the ledger across chunks and failed continuations.
  // Reading existing attempts uses no provider request or chunk budget.
  let consecutiveMisses = 0
  for (let index = 0; index < allGameIds.length; index++) {
    const gameId = allGameIds[index]
    if (index > 0 && gameId.slice(0, 3) !== allGameIds[index - 1].slice(0, 3)) consecutiveMisses = 0
    let isMissing = missing.has(gameId)
    if (!terminal.has(gameId)) {
      if (attempted === CDN_CHUNK) return await finishCdnEnumChunk(run, offset, index, false, counts)
      const outcome = await processCdnEnumGame(run, gameId)
      counts[outcome]++
      attempted++
      isMissing = outcome === 'missing'
      await delay(CDN_DELAY_MS)
    }
    consecutiveMisses = isMissing ? consecutiveMisses + 1 : 0
    if (consecutiveMisses > 25) {
      const nextRange = findNextCandidateRangeOffset(allGameIds, index)
      if (nextRange === null) break
      index = nextRange - 1
      consecutiveMisses = 0
    }
  }
  return await finishCdnEnumChunk(run, offset, allGameIds.length, true, counts)
}

async function processCdnEnumGame(run: BackfillRun, gameId: string): Promise<'completed' | 'failed' | 'missing'> {
  const { jobId, seasonYear } = run
  try {
    const resolver = await loadCdnPlayerResolver()
    const result = await fetchCdnGameOrMiss(gameId)
    if (result === 'missing') {
      await markBackfillGameMissing(jobId, 'cdn-enum', seasonYear, gameId)
      return 'missing'
    }

    const game = result
    if (!game || game.gameStatus !== 3) {
      await markBackfillGameFailed(jobId, 'cdn-enum', seasonYear, gameId, 'CDN game is not final')
      return 'failed'
    }

    validateBoxScorePlayers(game, gameId)
    const dbGame = await upsertCdnGame(gameId, game, seasonYear)
    const players = await resolveBoxScorePlayers(game, gameId, resolver)
    await upsertCdnStats(players, dbGame.id, gameId, seasonYear, dbGame.week_number)
    await markBackfillGameCompleted(jobId, 'cdn-enum', seasonYear, gameId, dbGame.id)
    return 'completed'
  } catch (e) {
    await markBackfillGameFailed(jobId, 'cdn-enum', seasonYear, gameId, e)
    console.warn(`[backfill/cdn-enum] ${gameId}: ${errorMessage(e)}`)
    return 'failed'
  }
}

async function finishCdnEnumChunk(
  run: BackfillRun,
  offset: number,
  nextOffset: number,
  isDone: boolean,
  counts: { completed: number; failed: number; missing: number },
): Promise<boolean> {
  const { jobId, seasonYear } = run
  if (isDone) await recalcCdnEnumWeekNumbers(seasonYear)
  const ledgerProgress = await syncBackfillLedgerProgress(jobId, 'cdn-enum', isDone)

  if (!isDone) {
    try {
      await invokeBackfill({ action: 'continue', source: 'cdn-enum', seasonYear, jobId, offset: nextOffset, claimToken: run.claimToken })
    } catch (e) {
      await failBackfillJob(jobId, e)
      throw e
    }
  }

  console.log(`[backfill/cdn-enum] Season ${seasonYear} offset=${offset}: ${counts.completed} ok, ${counts.failed} failed, ${counts.missing} missing; ledger=${ledgerProgress.completed_items}/${ledgerProgress.failed_items}/${ledgerProgress.missing_items}`)
  return !isDone
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

  if (res.status === 404) return 'missing'
  if (!res.ok) throw new Error(`CDN ${res.status}`)

  const data = await res.json() as CdnBoxScore
  return data.game ?? null
}

async function upsertCdnStats(
  players: Awaited<ReturnType<typeof resolveBoxScorePlayers>>,
  dbGameId: string,
  providerGameId: string,
  seasonYear: number,
  weekNumber: number,
): Promise<void> {
  const stats = players.map(({ player, playerId }) =>
    buildStatRow(player, playerId, dbGameId, seasonYear, weekNumber))
  if (!stats.length) throw new Error('No CDN player stats parsed from final box score')
  await saveGameStats(dbGameId, providerGameId, stats, true)
}

async function upsertCdnGame(gameId: string, game: CdnGame, seasonYear: number): Promise<DbGame> {
  const gameDate = game.gameEt?.split('T')[0]
  const homeTeam = game.homeTeam?.teamTricode ?? ''
  const awayTeam = game.awayTeam?.teamTricode ?? ''
  if (!gameDate || !homeTeam || !awayTeam) throw new Error(`CDN game ${gameId} is missing date or teams`)
  const calendar = await mustSupabase('locate CDN game week', supabase.from('season_weeks')
    .select('week_number').eq('season_year', seasonYear).lte('week_start', gameDate).gte('week_end', gameDate).maybeSingle())
  const weekNumber = calendar?.week_number ?? estimateCdnWeekNumber(seasonYear, gameDate)
  await assertGameImports([{ nba_game_id: gameId, season_year: seasonYear, game_date: gameDate, home_team: homeTeam, away_team: awayTeam }])

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
  const { error } = await supabase.rpc('rebuild_nba_calendar_atomic', {
    p_season_year: seasonYear,
  })
  if (error) throw error
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
