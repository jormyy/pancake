import { supabase } from '../_shared/supabase.ts'
import { requireInternalFunctionAuth } from '../_shared/auth.ts'
import { internalServerError } from '../_shared/responses.ts'

const SLEEPER_BASE_URL = Deno.env.get('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'
const NBA_CDN_BASE_URL = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
const SLEEPER_URL = `${SLEEPER_BASE_URL}/players/nba`
const NBA_PLAYER_INDEX_URL = `${NBA_CDN_BASE_URL}/staticData/playerIndex.json`
const CHUNK = 500
const AMBIGUOUS = '__ambiguous__'

Deno.serve(async (req) => {
  const authError = requireInternalFunctionAuth(req)
  if (authError) return authError

  try {
    await syncPlayers()
    await syncNBAIds()
    return Response.json({ ok: true })
  } catch (e: unknown) {
    return internalServerError('sync-players', e)
  }
})

async function syncPlayers() {
  console.log('[sync-players] Fetching from Sleeper...')
  const res = await fetch(SLEEPER_URL)
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

  // Paginate to avoid PostgREST max_rows cap
  const existing: { id: string; display_name: string | null; sleeper_id: string | null }[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error: fetchErr } = await supabase
      .from('players')
      .select('id, display_name, sleeper_id')
      .range(from, from + PAGE - 1)
    if (fetchErr) throw fetchErr
    if (!data || data.length === 0) break
    existing.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  const byExactName = new Map<string, string>()
  const byNormName = new Map<string, string>()
  const bySleeperId = new Map<string, string>()
  for (const p of existing) {
    if (p.display_name) {
      setUnique(byExactName, p.display_name.toLowerCase(), p.id)
      setUnique(byNormName, normalizeName(p.display_name), p.id)
    }
    if (p.sleeper_id) bySleeperId.set(p.sleeper_id, p.id)
  }

  const toUpdate: any[] = []
  const toInsert: any[] = []

  for (const p of sleeperPlayers) {
    const displayName = [p.first_name, p.last_name].filter(Boolean).join(' ')
    const playerData = {
      sleeper_id: p.player_id,
      first_name: p.first_name ?? '',
      last_name: p.last_name ?? '',
      nba_team: p.team ?? null,
      position: normalizePosition(p.position),
      eligible_positions: normalizeEligiblePositions(p.fantasy_positions),
      status: p.status ?? null,
      injury_status: normalizeInjuryStatus(p.injury_status),
      updated_at: new Date().toISOString(),
    }

    const exactNameId = byExactName.get(displayName.toLowerCase())
    const normalizedNameId = byNormName.get(normalizeName(displayName))
    const matchedNameId = exactNameId && exactNameId !== AMBIGUOUS
      ? exactNameId
      : (normalizedNameId && normalizedNameId !== AMBIGUOUS ? normalizedNameId : null)
    const existingId = bySleeperId.get(p.player_id) ?? matchedNameId
    if (existingId) {
      toUpdate.push({ id: existingId, ...playerData })
    } else {
      toInsert.push(playerData)
    }
  }

  // Deduplicate updates by id
  const seenIds = new Map<string, any>()
  for (const p of toUpdate) seenIds.set(p.id, p)
  const dedupedUpdate = Array.from(seenIds.values())

  for (let i = 0; i < dedupedUpdate.length; i += CHUNK) {
    // Strip sleeper_id from updates — it may conflict if a player was matched by
    // name but a different player already owns that sleeper_id.
    const chunk = dedupedUpdate.slice(i, i + CHUNK).map(({ sleeper_id: _sid, ...rest }) => rest)
    const { error } = await supabase
      .from('players')
      .upsert(chunk, { onConflict: 'id' })
    if (error) throw error
  }

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const { error } = await supabase
      .from('players')
      .upsert(toInsert.slice(i, i + CHUNK), { onConflict: 'sleeper_id' })
    if (error) console.error(`[sync-players] Insert error (chunk ${i}):`, error.message)
  }

  console.log(`[sync-players] ${dedupedUpdate.length} updated, ${toInsert.length} inserted.`)
}

// Fetch the NBA CDN player index and populate nba_id for any players missing it.
// The index includes all active NBA players with their PERSON_ID, first name, and last name
// (last name includes suffix, e.g. "Jackson Jr.", "Payton II").
async function syncNBAIds() {
  console.log('[sync-players] Syncing NBA person IDs from CDN index...')

  const res = await fetch(NBA_PLAYER_INDEX_URL, {
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

  // Paginate to avoid PostgREST max_rows cap
  const players: { id: string; display_name: string | null; nba_id: string | null }[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, display_name, nba_id')
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    players.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  const dbNormCounts = new Map<string, number>()
  const dbExactCounts = new Map<string, number>()
  const dbByNbaId = new Map<string, string>()
  for (const player of players) {
    if (player.nba_id) dbByNbaId.set(player.nba_id, player.id)
    if (!player.display_name) continue
    const exact = player.display_name.toLowerCase()
    const norm = normalizeName(player.display_name)
    dbExactCounts.set(exact, (dbExactCounts.get(exact) ?? 0) + 1)
    dbNormCounts.set(norm, (dbNormCounts.get(norm) ?? 0) + 1)
  }

  const updates: { id: string; nba_id: string }[] = []
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
      updates.push({ id: p.id, nba_id: personId })
    }
  }

  let mergedBeforeUpdate = 0
  for (const update of updates) {
    const existingOwnerId = dbByNbaId.get(update.nba_id)
    if (existingOwnerId && existingOwnerId !== update.id) {
      const { error: mergeErr } = await supabase.rpc('merge_players', {
        winner_id: existingOwnerId,
        loser_id: update.id,
      })
      if (mergeErr) throw mergeErr
      mergedBeforeUpdate++
      continue
    }

    const { error: updateErr } = await supabase
      .from('players')
      .update({ nba_id: update.nba_id })
      .eq('id', update.id)
    if (updateErr) throw updateErr
    dbByNbaId.set(update.nba_id, update.id)
  }

  console.log(`[sync-players] Updated nba_id for ${updates.length - mergedBeforeUpdate} players; merged ${mergedBeforeUpdate} duplicate rows before update.`)

  // Merge any players that ended up with the same nba_id (same real person, two DB rows)
  const { error: mergeErr } = await supabase.rpc('merge_duplicate_players')
  if (mergeErr) console.error('[sync-players] merge_duplicate_players error:', mergeErr.message)
  else console.log('[sync-players] Dedup complete.')
}

function setUnique(map: Map<string, string>, key: string, value: string): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, value)
  } else if (existing !== value) {
    map.set(key, AMBIGUOUS)
  }
}

import { normalizeName } from '../_shared/nameMatch.ts'

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
