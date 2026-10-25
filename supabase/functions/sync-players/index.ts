import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { recordSyncRun } from '../_shared/syncRuns.ts'
import { serveInternal } from '../_shared/serve.ts'
import { fetchEspnNews, fetchEspnPlayerListing } from '../_shared/playerSource.ts'
import { errorMessage } from '../_shared/responses.ts'
import { syncCareerGames } from './career.ts'
import { isInjuriesOnlyRequest, syncInjuries } from './injuries.ts'
import { importPlayerChunk } from './imports.ts'
import { syncNBAIds } from './nbaIds.ts'
import { releaseUnlistedPlayers, type HeldReleases, type ListedPlayer } from './release.ts'

const SLEEPER_BASE_URL = Deno.env.get('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'
const SLEEPER_URL = `${SLEEPER_BASE_URL}/players/nba`
const CHUNK = 500

// ESPN is the primary keyless source; Sleeper is a dormant fallback kept
// behind this flag (its commercial API moved behind negotiated licensing).
const PLAYER_SYNC_SOURCE = Deno.env.get('PLAYER_SYNC_SOURCE') ?? 'espn'

serveInternal('sync-players', async (req) => {
  const injuriesOnly = await isInjuriesOnlyRequest(req)
  const result = await recordSyncRun('sync-players', async () => {
    if (injuriesOnly) {
      const injuries = await syncInjuries()
      return { result: injuries, rowsAffected: injuries.updated, failure: injuries.failure }
    }
    const imported = PLAYER_SYNC_SOURCE === 'sleeper'
      ? await syncPlayers()
      : await importPlayersFromEspn()
    // The NBA index step runs between the ESPN import and its release: it merges a person's split rows (his
    // ESPN row into the row his box created), and the release must read the merged row, which holds both
    // his ESPN listing and his boxes. An index step that throws or fails a row releases nobody.
    const nbaIds = await syncNBAIds()
    const players = await releaseEspnOmissions(imported, nbaIds.failures)
    const news = await syncDynastyNews()
    const career = await syncCareerGames()
    const failures = [...players.failures, ...nbaIds.failures, ...news.failures, ...career.failures]
    const failure = failures.length > 0
      ? `sync-players had ${failures.length} failure(s): ${failures.join('; ')}`
      : null
    return {
      result: {
        updated: players.updated,
        inserted: players.inserted,
        released: players.released,
        releaseSkipped: players.releaseSkipped,
        releaseHeld: players.releaseHeld,
        ambiguousSkipped: players.ambiguousSkipped,
        nbaIdsMapped: nbaIds.mapped,
        merged: nbaIds.merged,
        careerGamesUpdated: career.updated,
        newsUpserted: news.upserted,
        newsFailures: news.failures,
        failure,
      },
      rowsAffected: players.updated + players.inserted + players.released + nbaIds.mapped + nbaIds.merged + news.upserted + career.updated,
      failure,
    }
  }, req)
  return Response.json({ ok: !result.failure, ...result }, { status: result.failure ? 500 : 200 })
})

type PlayerImportTotals = {
  updated: number; inserted: number; ambiguousSkipped: number; failures: string[]
  listing: { records: ListedPlayer[]; gaps: string[] } | null
}
type PlayerSyncTotals = Omit<PlayerImportTotals, 'listing'> & { released: number; releaseSkipped: string[]; releaseHeld: HeldReleases }

async function importPlayersFromEspn(): Promise<PlayerImportTotals> {
  console.log('[sync-players] Fetching from ESPN...')
  const { records, gaps, failure } = await fetchEspnPlayerListing()

  let updated = 0
  let inserted = 0
  let ambiguousSkipped = 0
  const failures: string[] = failure ? [failure] : []
  for (let offset = 0; offset < records.length; offset += CHUNK) {
    try {
      const result = await importPlayerChunk('espn', records.slice(offset, offset + CHUNK).map((record) => ({
        provider_id: record.espn_id, first_name: record.first_name, last_name: record.last_name,
        metadata: { nba_team: record.nba_team, position: record.position, eligible_positions: record.eligible_positions,
          status: record.status, ...(Object.hasOwn(record, 'injury_status') ? { injury_status: record.injury_status } : {}), years_exp: record.years_exp },
      })), offset)
      updated += result.updated
      inserted += result.inserted
      ambiguousSkipped += result.ambiguousSkipped
      failures.push(...result.failures)
    } catch (error) { failures.push(`import chunk ${offset}: ${errorMessage(error)}`) }
  }
  console.log(`[sync-players] ESPN: ${updated} updated, ${inserted} inserted, ${ambiguousSkipped} ambiguous skipped, ${failures.length} import failure(s).`)
  return { updated, inserted, ambiguousSkipped, failures, listing: { records, gaps } }
}

async function releaseEspnOmissions(imported: PlayerImportTotals, indexFailures: string[]): Promise<PlayerSyncTotals> {
  const { listing, ...totals } = imported
  // Sleeper's master list names free agents with no team, so it needs no release sweep.
  if (!listing) return { ...totals, released: 0, releaseSkipped: [], releaseHeld: { unproven: 0, unclaimed: 0 } }
  const release = await releaseUnlistedPlayers(listing.records, listing.gaps, totals.failures, indexFailures)
  console.log(`[sync-players] ESPN release: ${release.released} released.`)
  if (release.blockers.length > 0) console.log(`[sync-players] ESPN release skipped: ${release.blockers.join('; ')}`)
  if (release.held.unproven + release.held.unclaimed > 0) {
    console.log(`[sync-players] ESPN omits ${release.held.unproven} claimed player(s) and ${release.held.unclaimed} it never claimed, and no stored box shows them on another team, so their teams are held.`)
  }
  return { ...totals, released: release.released, releaseSkipped: release.blockers, releaseHeld: release.held,
    failures: [...totals.failures, ...release.failures] }
}

// Dormant Sleeper fallback path (PLAYER_SYNC_SOURCE=sleeper).
async function syncPlayers(): Promise<PlayerImportTotals> {
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
      const result = await importPlayerChunk('sleeper', sleeperPlayers.slice(offset, offset + CHUNK).map((p) => ({
        provider_id: p.player_id, first_name: p.first_name ?? '', last_name: p.last_name ?? '',
        metadata: { nba_team: p.team ?? null, position: normalizePosition(p.position),
          eligible_positions: normalizeEligiblePositions(p.fantasy_positions), status: p.status ?? null,
          injury_status: normalizeInjuryStatus(p.injury_status), years_exp: typeof p.years_exp === 'number' ? p.years_exp : null },
      })), offset)
      updated += result.updated
      inserted += result.inserted
      ambiguousSkipped += result.ambiguousSkipped
      failures.push(...result.failures)
    } catch (error) { failures.push(`import chunk ${offset}: ${errorMessage(error)}`) }
  }
  console.log(`[sync-players] Sleeper: ${updated} updated, ${inserted} inserted, ${ambiguousSkipped} ambiguous skipped, ${failures.length} import failure(s).`)
  return { updated, inserted, ambiguousSkipped, failures, listing: null }
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
