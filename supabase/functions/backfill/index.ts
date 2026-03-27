/**
 * backfill — chunked self-chaining historical data backfill.
 *
 * Handles two sources:
 *   - "cdn": NBA CDN box scores for seasons 2019-20 through 2024-25
 *   - "bbref": Basketball-Reference scraper for seasons 2003-04 through 2018-19
 *
 * Since Edge Functions have a 150s timeout:
 *   - CDN:   ~300 games per chunk (500ms/game × 300 = 150s)
 *   - BBRef: ~40 games per chunk  (3s/game × 40 = 120s)
 *
 * After each chunk, the function invokes itself with the next offset,
 * so the full backfill runs as a chain of fast-returning invocations.
 *
 * POST /backfill
 *   { "action": "start",    "source": "cdn"|"bbref", "seasonYear": 2025 }
 *   { "action": "continue", "source": "cdn"|"bbref", "jobId": "...", "seasonYear": 2025, "offset": 300 }
 *   { "action": "start-all" }   — queues all CDN seasons then all BBRef seasons
 */
import { supabase } from '../_shared/supabase.ts'
import { buildStatRow } from '../_shared/syncStats.ts'
import { fetchBBRefSchedule, fetchBBRefBoxScore, BBREF_TO_TRICODE, sleep } from '../_shared/bbref.ts'

// CDN start years (2-digit): 19 = 2019-20 (season_year=2020) … 24 = 2024-25 (season_year=2025)
const CDN_START_YEARS = [24, 23, 22, 21, 20, 19] as const
const BBREF_SEASON_YEARS = Array.from({ length: 17 }, (_, i) => 2003 + i) // 2003-2019

// For DB-driven mode (existing games), process fewer games per chunk to stay within 150s
// ~30 games × 4s avg per box score = 120s
const CDN_CHUNK = 30
const BBREF_CHUNK = 40
const CDN_DELAY_MS = 200
const CDN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
}

Deno.serve(async (req) => {
  try {
    const body = await req.json()
    const { action, source, seasonYear, jobId, offset = 0 } = body

    if (action === 'start-all') {
      // Queue all historical seasons newest → oldest
      // CDN seasons (2020-25 = season_year 2021-2025): use enumeration to discover + fill games
      // BBRef seasons (2003-19 = season_year 2004-2019): use BBRef scraper
      const results = []
      for (const startYY of CDN_START_YEARS) {
        const sy = 2000 + startYY + 1
        const jid = await createJob('cdn-enum', sy)
        results.push({ source: 'cdn-enum', seasonYear: sy, jobId: jid })
        await invokeSelf({ action: 'continue', source: 'cdn-enum', seasonYear: sy, jobId: jid, offset: 0 })
      }
      for (const sy of BBREF_SEASON_YEARS) {
        const jid = await createJob('bbref', sy)
        results.push({ source: 'bbref', seasonYear: sy, jobId: jid })
        await invokeSelf({ action: 'continue', source: 'bbref', seasonYear: sy, jobId: jid, offset: 0 })
      }
      return Response.json({ ok: true, queued: results })
    }

    if (action === 'start') {
      const jid = await createJob(source, seasonYear)
      await invokeSelf({ action: 'continue', source, seasonYear, jobId: jid, offset: 0 })
      return Response.json({ ok: true, jobId: jid })
    }

    if (action === 'continue') {
      if (source === 'cdn') {
        await runCDNChunk(seasonYear, jobId, offset)
      } else if (source === 'cdn-enum') {
        // Enumeration mode: discover + fill games sequentially for seasons not yet in DB
        await runCDNEnumChunk(seasonYear, jobId, offset)
      } else if (source === 'bbref') {
        await runBBRefChunk(seasonYear, jobId, offset)
      } else {
        return Response.json({ ok: false, error: 'Unknown source' }, { status: 400 })
      }
      return Response.json({ ok: true, jobId, offset })
    }

    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 })
  } catch (e: any) {
    console.error('[backfill]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
  }
})

async function createJob(source: string, seasonYear: number): Promise<string> {
  const { data, error } = await supabase
    .from('sync_jobs')
    .insert({
      job_type: `backfill_${source}_${seasonYear}`,
      status: 'pending',
      completed_items: 0,
      failed_items: 0,
      error_log: [],
      metadata: { source, seasonYear },
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function invokeSelf(body: Record<string, unknown>) {
  // Use pg_net via Supabase RPC — the DB manages the outbound HTTP request,
  // so it fires reliably even after this function returns its response.
  const { error } = await supabase.rpc('invoke_edge_function', {
    function_name: 'backfill',
    body,
  })
  if (error) console.error('[backfill] invokeSelf error:', error.message)
}

// ── CDN Historical Backfill ──────────────────────────────────────────────
// DB-driven: queries existing nba_games records and fills in missing stats.
// Chunk size = CDN_CHUNK games; each chunk fires the next before returning.

async function runCDNChunk(seasonYear: number, jobId: string, offset: number) {
  // Load ALL Final games (paginated to bypass 1000-row limit)
  const allGamesRaw: any[] = []
  let gamePage = 0
  while (true) {
    const { data: rows } = await supabase
      .from('nba_games')
      .select('id, nba_game_id, week_number')
      .eq('season_year', seasonYear)
      .eq('status', 'Final')
      .not('nba_game_id', 'is', null)
      .order('game_date', { ascending: true })
      .range(gamePage * 1000, (gamePage + 1) * 1000 - 1)
    if (!rows?.length) break
    allGamesRaw.push(...rows)
    if (rows.length < 1000) break
    gamePage++
  }

  // Load all synced game_ids (paginated)
  const syncedSet = new Set<string>()
  let page = 0
  while (true) {
    const { data: rows } = await supabase
      .from('player_game_stats')
      .select('game_id')
      .eq('season_year', seasonYear)
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (!rows?.length) break
    for (const r of rows) syncedSet.add((r as any).game_id)
    if (rows.length < 1000) break
    page++
  }

  const pending = allGamesRaw.filter((g: any) => !syncedSet.has(g.id))

  // Update total_items on first chunk
  if (offset === 0) {
    await supabase.from('sync_jobs').update({ total_items: pending.length }).eq('id', jobId)
  }

  const chunk = pending.slice(offset, offset + CDN_CHUNK)
  if (!chunk.length) {
    await supabase.from('sync_jobs').update({
      status: 'completed',
      completed_items: pending.length,
      completed_at: new Date().toISOString(),
    }).eq('id', jobId)
    console.log(`[backfill/cdn] Season ${seasonYear} complete.`)
    return
  }

  // Load player maps
  const { data: players } = await supabase.from('players').select('id, display_name, nba_id')
  const byNbaId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const p of players ?? []) {
    if (p.nba_id) byNbaId.set(p.nba_id, p.id)
    byName.set(p.display_name.toLowerCase(), p.id)
  }

  let completed = 0
  let failed = 0
  const nbaIdUpdates: { id: string; nba_id: string }[] = []

  for (const dbGame of chunk) {
    const gameId = dbGame.nba_game_id
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12_000)
      const res = await fetch(
        `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`,
        { headers: CDN_HEADERS, signal: controller.signal },
      ).finally(() => clearTimeout(timeout))

      if (!res.ok) {
        console.warn(`[backfill/cdn] ${gameId}: HTTP ${res.status}`)
        failed++
        await new Promise((r) => setTimeout(r, CDN_DELAY_MS))
        continue
      }

      const data = await res.json() as any
      const game = data.game
      if (!game || game.gameStatus !== 3) {
        completed++  // Game not final on CDN yet, skip gracefully
        continue
      }

      const allPlayers = [
        ...(game.homeTeam?.players ?? []),
        ...(game.awayTeam?.players ?? []),
      ]

      const stats: any[] = []
      for (const p of allPlayers) {
        if (!p.statistics) continue
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
        // Auto-create player if not found
        if (!playerId) {
          const nameParts = (p.name ?? '').trim().split(' ')
          const firstName = nameParts[0] ?? ''
          const lastName = nameParts.slice(1).join(' ') || firstName
          const { data: newPlayer } = await supabase
            .from('players')
            .insert({ first_name: firstName, last_name: lastName, nba_id: personId })
            .select('id')
            .maybeSingle()
          if (newPlayer) {
            playerId = newPlayer.id
            byNbaId.set(personId, playerId)
            byName.set((p.name ?? '').toLowerCase(), playerId)
          }
        }
        if (!playerId) continue
        stats.push(buildStatRow(p, playerId, dbGame.id, seasonYear, dbGame.week_number))
      }

      if (stats.length) {
        await supabase
          .from('player_game_stats')
          .upsert(stats, { onConflict: 'player_id,game_id' })
      }

      completed++
    } catch (e: any) {
      failed++
      console.warn(`[backfill/cdn] ${gameId}: ${e.message}`)
    }

    await new Promise((r) => setTimeout(r, CDN_DELAY_MS))
  }

  // Persist nba_id mappings
  for (const u of nbaIdUpdates) {
    await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
  }

  const nextOffset = offset + CDN_CHUNK
  const isDone = nextOffset >= pending.length

  // Update job progress
  await supabase.from('sync_jobs').update({
    completed_items: offset + completed,
    failed_items: offset === 0 ? failed : undefined,
    status: isDone ? 'completed' : 'pending',
    ...(isDone ? { completed_at: new Date().toISOString() } : {}),
  }).eq('id', jobId)

  // Chain next chunk (fire-and-forget)
  if (!isDone) {
    await invokeSelf({ action: 'continue', source: 'cdn', seasonYear, jobId, offset: nextOffset })
  }

  console.log(`[backfill/cdn] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed, ${pending.length - nextOffset} remaining`)
}

// ── CDN Enumeration Backfill (historical seasons not yet in DB) ─────────
// Generates sequential game IDs, fetches box scores, upserts games + stats.
// CDN_CHUNK=30 × ~700ms/game = ~21s per chunk, well within 150s timeout.

async function runCDNEnumChunk(seasonYear: number, jobId: string, offset: number) {
  const yy = String(seasonYear - 2001).padStart(2, '0')

  // Build the full ordered list of candidate game IDs
  const allGameIds: string[] = []
  for (let n = 1; n <= 1300; n++) allGameIds.push(`002${yy}0${String(n).padStart(4, '0')}`)
  for (let n = 1; n <= 400; n++) allGameIds.push(`004${yy}0${String(n).padStart(4, '0')}`)

  const chunk = allGameIds.slice(offset, offset + CDN_CHUNK)
  if (!chunk.length) {
    await supabase.from('sync_jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', jobId)
    return
  }

  // Load player maps
  const { data: players } = await supabase.from('players').select('id, display_name, nba_id')
  const byNbaId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const p of players ?? []) {
    if (p.nba_id) byNbaId.set(p.nba_id, p.id)
    byName.set(p.display_name.toLowerCase(), p.id)
  }

  let completed = 0
  let failed = 0
  let consecutiveMisses = 0
  let done = false
  const nbaIdUpdates: { id: string; nba_id: string }[] = []

  for (const gameId of chunk) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12_000)
      const res = await fetch(
        `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`,
        { headers: CDN_HEADERS, signal: controller.signal },
      ).finally(() => clearTimeout(timeout))

      if (res.status === 404 || res.status === 403) {
        consecutiveMisses++
        if (consecutiveMisses > 25) { done = true; break }
        await new Promise((r) => setTimeout(r, CDN_DELAY_MS))
        continue
      }
      if (!res.ok) throw new Error(`CDN ${res.status}`)
      consecutiveMisses = 0

      const data = await res.json() as any
      const game = data.game
      if (!game || game.gameStatus !== 3) {
        await new Promise((r) => setTimeout(r, CDN_DELAY_MS))
        continue
      }

      const gameDate = game.gameEt?.split('T')[0]
      const homeTricode = game.homeTeam?.teamTricode ?? ''
      const awayTricode = game.awayTeam?.teamTricode ?? ''
      if (!gameDate || !homeTricode || !awayTricode) continue

      // Upsert game record (will use default week_number=0; sync-schedule will fix later)
      await supabase.from('nba_games').upsert({
        nba_game_id: gameId,
        season_year: seasonYear,
        game_date: gameDate,
        home_team: homeTricode,
        away_team: awayTricode,
        status: 'Final',
        week_number: 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'nba_game_id' })

      const { data: dbGame } = await supabase
        .from('nba_games').select('id, week_number').eq('nba_game_id', gameId).single()
      if (!dbGame) continue

      const allPlayers = [...(game.homeTeam?.players ?? []), ...(game.awayTeam?.players ?? [])]
      const stats: any[] = []

      for (const p of allPlayers) {
        if (!p.statistics) continue
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
        if (!playerId) {
          const nameParts = (p.name ?? '').trim().split(' ')
          const { data: newP } = await supabase
            .from('players')
            .insert({ first_name: nameParts[0] ?? '', last_name: nameParts.slice(1).join(' ') || nameParts[0], nba_id: personId })
            .select('id').maybeSingle()
          if (newP) {
            playerId = newP.id
            byNbaId.set(personId, playerId)
            byName.set((p.name ?? '').toLowerCase(), playerId)
          }
        }
        if (!playerId) continue
        stats.push(buildStatRow(p, playerId, dbGame.id, seasonYear, dbGame.week_number))
      }

      if (stats.length) {
        await supabase.from('player_game_stats').upsert(stats, { onConflict: 'player_id,game_id' })
      }
      completed++
    } catch (e: any) {
      failed++
      console.warn(`[backfill/cdn-enum] ${gameId}: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, CDN_DELAY_MS))
  }

  // Persist nba_id mappings
  for (const u of nbaIdUpdates) {
    await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
  }

  const nextOffset = offset + CDN_CHUNK
  const isDone = done || nextOffset >= allGameIds.length

  await supabase.from('sync_jobs').update({
    completed_items: offset + completed,
    status: isDone ? 'completed' : 'pending',
    ...(isDone ? { completed_at: new Date().toISOString() } : {}),
  }).eq('id', jobId)

  if (!isDone) {
    await invokeSelf({ action: 'continue', source: 'cdn-enum', seasonYear, jobId, offset: nextOffset })
  }

  console.log(`[backfill/cdn-enum] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed`)
}

// ── BBRef Historical Backfill ────────────────────────────────────────────

async function runBBRefChunk(seasonYear: number, jobId: string, offset: number) {
  // Load player maps
  const { data: players } = await supabase.from('players').select('id, display_name')
  const byName = new Map<string, string>()
  for (const p of players ?? []) {
    byName.set(normalizePlayerName(p.display_name), p.id)
  }

  // On first chunk: scrape schedule and upsert all game records
  let games: any[] = []
  if (offset === 0) {
    console.log(`[backfill/bbref] Scraping schedule for ${seasonYear}...`)
    const scheduleGames = await fetchBBRefSchedule(seasonYear)

    if (!scheduleGames.length) {
      await supabase.from('sync_jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', jobId)
      return
    }

    // Calculate week numbers
    const dateCounts = new Map<string, number>()
    for (const g of scheduleGames) dateCounts.set(g.gameDate, (dateCounts.get(g.gameDate) ?? 0) + 1)
    const bulkStart = [...dateCounts.entries()].filter(([, c]) => c >= 5).map(([d]) => d).sort()[0]
    const seasonStart = bulkStart ?? scheduleGames.map((g) => g.gameDate).sort()[0]
    const startMs = new Date(seasonStart).getTime()
    const getWk = (date: string) => Math.max(1, Math.floor((new Date(date).getTime() - startMs) / 86_400_000 / 7) + 1)

    const weekMap: Record<number, { start: string; end: string }> = {}
    const gameRecords = scheduleGames.map((g) => {
      const wk = getWk(g.gameDate)
      if (!weekMap[wk]) weekMap[wk] = { start: g.gameDate, end: g.gameDate }
      else {
        if (g.gameDate < weekMap[wk].start) weekMap[wk].start = g.gameDate
        if (g.gameDate > weekMap[wk].end) weekMap[wk].end = g.gameDate
      }
      return {
        nba_game_id: g.bbrefId,
        season_year: seasonYear,
        game_date: g.gameDate,
        home_team: g.homeTeam,
        away_team: g.awayTeam,
        status: 'Final',
        week_number: wk,
        updated_at: new Date().toISOString(),
        _bbrefHomeTeam: g.homeTeamBBRef,
        _bbrefAwayTeam: g.awayTeamBBRef,
      }
    })

    // Upsert game records (without the _ prefixed fields)
    for (let i = 0; i < gameRecords.length; i += 500) {
      const chunk = gameRecords.slice(i, i + 500).map(({ _bbrefHomeTeam: _h, _bbrefAwayTeam: _a, ...rest }) => rest)
      await supabase.from('nba_games').upsert(chunk, { onConflict: 'nba_game_id' })
    }

    const weeks = Object.entries(weekMap).map(([wk, range]) => ({
      season_year: seasonYear,
      week_number: parseInt(wk),
      week_start: range.start,
      week_end: range.end,
    }))
    await supabase.from('season_weeks').upsert(weeks, { onConflict: 'season_year,week_number' })

    await supabase.from('sync_jobs').update({
      total_items: scheduleGames.length,
      metadata: { source: 'bbref', seasonYear, phase: 'boxscores' },
    }).eq('id', jobId)

    // Store schedule in metadata for subsequent chunks (just game IDs)
    // We'll re-load from DB for subsequent chunks
    games = gameRecords
  }

  // Load game list from DB for this season (for chunks after offset 0)
  const { data: dbGames } = await supabase
    .from('nba_games')
    .select('id, nba_game_id, week_number')
    .eq('season_year', seasonYear)
    .order('game_date', { ascending: true })
  const dbGameMap = new Map((dbGames ?? []).map((g: any) => [g.nba_game_id, g]))

  // Load already-synced game IDs (paginated to handle large seasons)
  const syncedGameIds = new Set<string>()
  let page = 0
  const PAGE_SIZE = 1000
  while (true) {
    const { data: syncedRows } = await supabase
      .from('player_game_stats')
      .select('game_id')
      .eq('season_year', seasonYear)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (!syncedRows?.length) break
    for (const r of syncedRows) syncedGameIds.add((r as any).game_id)
    if (syncedRows.length < PAGE_SIZE) break
    page++
  }

  // Get all game IDs in order and find the ones needing box scores
  const allDbGameIds = (dbGames ?? []).map((g: any) => g.nba_game_id)
  const pendingGameIds = allDbGameIds.filter((id: string) => {
    const dbGame = dbGameMap.get(id)
    return dbGame && !syncedGameIds.has(dbGame.id)
  })

  const chunkGameIds = pendingGameIds.slice(offset, offset + BBREF_CHUNK)
  if (!chunkGameIds.length) {
    await supabase.from('sync_jobs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', jobId)
    console.log(`[backfill/bbref] Season ${seasonYear} complete.`)
    return
  }

  let completed = 0
  let failed = 0

  for (const gameId of chunkGameIds) {
    const dbGame = dbGameMap.get(gameId)
    if (!dbGame) continue

    try {
      // Reconstruct BBRef team codes from game ID
      // BBRef game ID format: YYYYMMDD0TEAM (home team at end)
      const homeTeamBBRef = gameId.substring(9)
      // Find away team from nba_games record
      const { data: gameRecord } = await supabase
        .from('nba_games')
        .select('home_team, away_team')
        .eq('nba_game_id', gameId)
        .single()

      const awayNBATricode = gameRecord?.away_team ?? ''
      // Reverse lookup: find BBRef code from tricode
      const awayTeamBBRef = Object.entries(BBREF_TO_TRICODE).find(([, v]) => v === awayNBATricode)?.[0] ?? awayNBATricode

      const boxScore = await fetchBBRefBoxScore(gameId, homeTeamBBRef, awayTeamBBRef)
      const allPlayers = [
        ...boxScore.home.map((s) => ({ stat: s, team: gameRecord?.home_team })),
        ...boxScore.away.map((s) => ({ stat: s, team: gameRecord?.away_team })),
      ]

      const stats: any[] = []
      for (const { stat } of allPlayers) {
        const normName = normalizePlayerName(stat.playerName)
        let playerId = byName.get(normName)

        // Auto-create player if not found
        if (!playerId) {
          const nameParts = stat.playerName.trim().split(' ')
          const firstName = nameParts[0] ?? ''
          const lastName = nameParts.slice(1).join(' ') || firstName
          const { data: newPlayer } = await supabase
            .from('players')
            .insert({ first_name: firstName, last_name: lastName })
            .select('id')
            .maybeSingle()
          if (newPlayer) {
            playerId = newPlayer.id
            byName.set(normName, playerId)
          }
        }
        if (!playerId) continue

        const minutesPlayed = stat.minutesDecimal
        const dnp = stat.dnp || !minutesPlayed || minutesPlayed < 0.5
        const pts = stat.pts
        const reb = stat.reb
        const ast = stat.ast
        const stl = stat.stl
        const blk = stat.blk
        const statCats = [pts >= 10, reb >= 10, ast >= 10, stl >= 10, blk >= 10].filter(Boolean).length

        stats.push({
          player_id: playerId,
          game_id: dbGame.id,
          season_year: seasonYear,
          week_number: dbGame.week_number,
          minutes_played: minutesPlayed,
          points: pts,
          rebounds: reb,
          offensive_rebounds: stat.orb,
          defensive_rebounds: stat.drb,
          assists: ast,
          steals: stl,
          blocks: blk,
          turnovers: stat.tov,
          personal_fouls: stat.pf,
          field_goals_made: stat.fgm,
          field_goals_attempted: stat.fga,
          three_pointers_made: stat.tpm,
          three_pointers_attempted: stat.tpa,
          free_throws_made: stat.ftm,
          free_throws_attempted: stat.fta,
          plus_minus: stat.plusMinus,
          double_double: statCats >= 2,
          triple_double: statCats >= 3,
          did_not_play: dnp,
          updated_at: new Date().toISOString(),
        })
      }

      if (stats.length) {
        await supabase.from('player_game_stats').upsert(stats, { onConflict: 'player_id,game_id' })
      }

      completed++
    } catch (e: any) {
      failed++
      console.warn(`[backfill/bbref] ${gameId}: ${e.message}`)
    }

    await sleep(3000)
  }

  const nextOffset = offset + BBREF_CHUNK
  const isDone = nextOffset >= pendingGameIds.length

  await supabase.from('sync_jobs').update({
    completed_items: offset + completed,
    failed_items: failed,
    ...(isDone ? { status: 'completed', completed_at: new Date().toISOString() } : {}),
  }).eq('id', jobId)

  if (!isDone) {
    await invokeSelf({ action: 'continue', source: 'bbref', seasonYear, jobId, offset: nextOffset })
  }

  console.log(`[backfill/bbref] Season ${seasonYear} offset=${offset}: ${completed} ok, ${failed} failed`)
}


function normalizePlayerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '')
    .replace(/[.']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
