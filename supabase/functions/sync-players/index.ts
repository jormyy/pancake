import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { AMBIGUOUS, normalizeName, setUnique } from '../_shared/nameMatch.ts'
import { fetchEspnNews, fetchEspnPlayerRecords } from '../_shared/playerSource.ts'
import { fetchAllPlayers } from './players.ts'
import { resolvePlayerImports } from '../_shared/playerImports.ts'
import { errorMessage } from '../_shared/responses.ts'

const SLEEPER_BASE_URL = Deno.env.get('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'
const NBA_CDN_BASE_URL = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
const SLEEPER_URL = `${SLEEPER_BASE_URL}/players/nba`
const NBA_PLAYER_INDEX_URL = `${NBA_CDN_BASE_URL}/staticData/playerIndex.json`
const CHUNK = 500

// ESPN is the primary keyless source; Sleeper is a dormant fallback kept
// behind this flag (its commercial API moved behind negotiated licensing).
const PLAYER_SYNC_SOURCE = Deno.env.get('PLAYER_SYNC_SOURCE') ?? 'espn'

serveInternal('sync-players', async () => {
  const result = await recordSyncRun('sync-players', async () => {
    const players = PLAYER_SYNC_SOURCE === 'sleeper'
      ? await syncPlayers()
      : await syncPlayersFromEspn()
    const nbaIds = await syncNBAIds()
    const news = await syncDynastyNews()
    const failures = [...players.failures, ...nbaIds.failures, ...news.failures]
    if (failures.length > 0) {
      throw new Error(`sync-players had ${failures.length} failure(s): ${failures.join('; ')}`)
    }
    return {
      result: {
        updated: players.updated,
        inserted: players.inserted,
        ambiguousSkipped: players.ambiguousSkipped,
        nbaIdsMapped: nbaIds.mapped,
        merged: nbaIds.merged,
        newsUpserted: news.upserted,
        newsFailures: news.failures,
      },
      rowsAffected: players.updated + players.inserted + nbaIds.mapped + nbaIds.merged + news.upserted,
    }
  })
  return Response.json({ ok: true, ...result })
})

async function syncPlayersFromEspn(): Promise<{ updated: number; inserted: number; ambiguousSkipped: number; failures: string[] }> {
  console.log('[sync-players] Fetching from ESPN...')
  const records = await fetchEspnPlayerRecords()

  let updated = 0
  let inserted = 0
  let ambiguousSkipped = 0
  const failures: string[] = []
  for (let offset = 0; offset < records.length; offset += CHUNK) {
    try {
      const { results } = await resolvePlayerImports('espn', records.slice(offset, offset + CHUNK).map((record) => ({
        provider_id: record.espn_id, first_name: record.first_name, last_name: record.last_name,
        metadata: { nba_team: record.nba_team, position: record.position, eligible_positions: record.eligible_positions,
          status: record.status, injury_status: record.injury_status, years_exp: record.years_exp },
      })))
      updated += results.filter((row) => row.action === 'updated').length
      inserted += results.filter((row) => row.action === 'inserted').length
      ambiguousSkipped += results.filter((row) => row.action === 'ambiguous').length
    } catch (error) { failures.push(`import chunk ${offset}: ${errorMessage(error)}`) }
  }
  console.log(`[sync-players] ESPN: ${updated} updated, ${inserted} inserted, ${ambiguousSkipped} ambiguous skipped, ${failures.length} failed chunk(s).`)
  return { updated, inserted, ambiguousSkipped, failures }
}

// Dormant Sleeper fallback path (PLAYER_SYNC_SOURCE=sleeper).
async function syncPlayers(): Promise<{ updated: number; inserted: number; ambiguousSkipped: number; failures: string[] }> {
  console.log('[sync-players] Fetching from Sleeper...')
  const res = await fetchWithRetry(SLEEPER_URL)
  if (!res.ok) throw new Error(`Sleeper API ${res.status}`)
  const raw = await res.json() as Record<string, any>

  const sleeperPlayers = Object.values(raw).filter(
    (p) =>
      p.sport === 'nba' &&
      (p.first_name || p.last_name) &&
      // Sleeper returns all 30 teams as pseudo-players with player_id = team code (e.g. "PHI").
      // Exclude them: real player IDs are always numeric strings.
      /^\d+$/.test(p.player_id ?? ''),
  )

  let updated = 0
  let inserted = 0
  let ambiguousSkipped = 0
  const failures: string[] = []
  for (let offset = 0; offset < sleeperPlayers.length; offset += CHUNK) {
    try {
      const { results } = await resolvePlayerImports('sleeper', sleeperPlayers.slice(offset, offset + CHUNK).map((p) => ({
        provider_id: p.player_id, first_name: p.first_name ?? '', last_name: p.last_name ?? '',
        metadata: { nba_team: p.team ?? null, position: normalizePosition(p.position),
          eligible_positions: normalizeEligiblePositions(p.fantasy_positions), status: p.status ?? null,
          injury_status: normalizeInjuryStatus(p.injury_status), years_exp: typeof p.years_exp === 'number' ? p.years_exp : null },
      })))
      updated += results.filter((row) => row.action === 'updated').length
      inserted += results.filter((row) => row.action === 'inserted').length
      ambiguousSkipped += results.filter((row) => row.action === 'ambiguous').length
    } catch (error) { failures.push(`import chunk ${offset}: ${errorMessage(error)}`) }
  }
  console.log(`[sync-players] Sleeper: ${updated} updated, ${inserted} inserted, ${ambiguousSkipped} ambiguous skipped, ${failures.length} failed chunk(s).`)
  return { updated, inserted, ambiguousSkipped, failures }
}

// Fetch the NBA CDN player index and populate nba_id for any players missing it.
// The index includes all active NBA players with their PERSON_ID, first name, and last name
// (last name includes suffix, e.g. "Jackson Jr.", "Payton II").
async function syncNBAIds(): Promise<{ mapped: number; merged: number; failures: string[] }> {
  console.log('[sync-players] Syncing NBA person IDs from CDN index...')

  const res = await fetchWithRetry(NBA_PLAYER_INDEX_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://www.nba.com/',
      'Origin': 'https://www.nba.com',
    },
  })
  if (!res.ok) throw new Error(`NBA player index ${res.status}`)

  const data = await res.json() as { resultSets?: { headers: string[]; rowSet: unknown[][] }[] }
  const rs = data?.resultSets?.[0]
  if (!rs) throw new Error('Unexpected NBA player index shape')

  const headers = rs.headers
  const rows = rs.rowSet

  const pidIdx = headers.indexOf('PERSON_ID')
  const firstIdx = headers.indexOf('PLAYER_FIRST_NAME')
  const lastIdx = headers.indexOf('PLAYER_LAST_NAME')
  const statusIdx = headers.indexOf('ROSTER_STATUS')

  // Build maps from the active CDN index. Exact names are preferred; normalized
  // names are used only when unique on both the CDN and DB sides.
  const byExactName = new Map<string, string>()
  const byNormName = new Map<string, string>()
  for (const row of rows) {
    if (row[statusIdx] !== 1) continue // skip inactive
    const fullName = `${row[firstIdx]} ${row[lastIdx]}`
    const exact = fullName.toLowerCase()
    const norm = normalizeName(fullName)
    const personId = String(row[pidIdx])
    setUnique(byExactName, exact, personId)
    setUnique(byNormName, norm, personId)
  }

  const players = await fetchAllPlayers<{ id: string; display_name: string | null; nba_id: string | null }>(
    supabase,
    'id, display_name, nba_id',
  )

  const dbNormCounts = new Map<string, number>()
  const dbExactCounts = new Map<string, number>()
  for (const player of players) {
    if (!player.display_name) continue
    const exact = player.display_name.toLowerCase()
    const norm = normalizeName(player.display_name)
    dbExactCounts.set(exact, (dbExactCounts.get(exact) ?? 0) + 1)
    dbNormCounts.set(norm, (dbNormCounts.get(norm) ?? 0) + 1)
  }

  const updates: { id: string; nba_id: string; expected_display_name: string; name_match: string }[] = []
  for (const p of players) {
    if (!p.display_name) continue
    const exact = p.display_name.toLowerCase()
    const norm = normalizeName(p.display_name)
    const exactPersonId = byExactName.get(exact)
    const normPersonId = byNormName.get(norm)
    const personId = exactPersonId && exactPersonId !== AMBIGUOUS && dbExactCounts.get(exact) === 1
      ? exactPersonId
      : (dbNormCounts.get(norm) === 1 && normPersonId && normPersonId !== AMBIGUOUS ? normPersonId : null)
    if (personId && !p.nba_id) {
      updates.push({ id: p.id, nba_id: personId, expected_display_name: p.display_name,
        name_match: exactPersonId === personId && dbExactCounts.get(exact) === 1 ? 'exact' : 'normalized' })
    }
  }

  let mergedBeforeUpdate = 0
  let mapped = 0
  for (let offset = 0; offset < updates.length; offset += CHUNK) {
    const chunk = updates.slice(offset, offset + CHUNK)
    const { results } = await resolvePlayerImports('nba_index', chunk.map((update) => ({
      player_id: update.id, provider_id: update.nba_id,
      expected_display_name: update.expected_display_name, name_match: update.name_match,
    })))
    for (const row of results) {
      if (!row.player_id) continue
      if (row.player_id !== chunk[row.index].id) mergedBeforeUpdate++
      else mapped++
    }
  }
  console.log(`[sync-players] Updated nba_id for ${mapped} players; merged ${mergedBeforeUpdate} duplicate rows before update.`)

  // Merge any players that ended up with the same nba_id (same real person, two DB rows)
  const failures: string[] = []
  const { error: mergeErr } = await supabase.rpc('merge_duplicate_players')
  if (mergeErr) failures.push(`merge_duplicate_players: ${mergeErr.message}`)
  else console.log('[sync-players] Dedup complete.')

  return { mapped, merged: mergedBeforeUpdate, failures }
}

// Sleeper sometimes returns "Scrambled" as a catch-all when injury data is uncertain — treat as null
const JUNK_INJURY_STATUSES = new Set(['Scrambled'])

function normalizeInjuryStatus(s: string | null | undefined): string | null {
  if (!s || JUNK_INJURY_STATUSES.has(s)) return null
  return s
}

function normalizePosition(pos: string | null | undefined): string | null {
  const map: Record<string, string> = {
    PG: 'PG', SG: 'SG', SF: 'SF', PF: 'PF', C: 'C', G: 'G', F: 'F',
  }
  return pos ? (map[pos] ?? null) : null
}

const VALID_POSITIONS = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'])

function normalizeEligiblePositions(positions: string[] | null | undefined): string[] {
  if (!positions) return []
  return positions.filter((p) => VALID_POSITIONS.has(p))
}

// Dynasty Hub news: ESPN articles keyed by url; athlete-tagged stories link to
// the matching player through espn_id. A failed feed leaves existing news
// untouched and reports the whole player sync as failed so cron health stays
// truthful. The next scheduled run retries the feed without manual action.
async function syncDynastyNews(): Promise<{ upserted: number; failures: string[] }> {
  try {
    const items = await fetchEspnNews()
    if (items.length === 0) return { upserted: 0, failures: [] }

    const athleteIds = [...new Set(items.flatMap((item) => item.espn_athlete_id ? [item.espn_athlete_id] : []))]
    const playerByEspnId = new Map<string, string>()
    if (athleteIds.length > 0) {
      const { data, error } = await supabase
        .from('players')
        .select('id, espn_id')
        .in('espn_id', athleteIds)
      if (error) throw error
      for (const player of data ?? []) {
        if (player.espn_id) playerByEspnId.set(player.espn_id, player.id)
      }
    }

    const rows = items.map((item) => ({
      title: item.title,
      summary: item.summary,
      source: item.source,
      url: item.url,
      published_at: item.published_at,
      player_id: item.espn_athlete_id ? playerByEspnId.get(item.espn_athlete_id) ?? null : null,
    }))
    const { error } = await supabase
      .from('dynasty_news')
      .upsert(rows, { onConflict: 'url' })
    if (error) throw error

    console.log(`[sync-players] dynasty news: ${rows.length} upserted.`)
    return { upserted: rows.length, failures: [] }
  } catch (error) {
    const message = (error as { message?: string } | null)?.message ?? String(error)
    console.error(`[sync-players] dynasty news failed: ${message}`)
    return { upserted: 0, failures: [`news: ${message}`] }
  }
}
