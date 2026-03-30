import { supabase } from '../_shared/supabase.ts'

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nba'
const NBA_PLAYER_INDEX_URL = 'https://cdn.nba.com/static/json/staticData/playerIndex.json'
const CHUNK = 500

Deno.serve(async () => {
  try {
    await syncPlayers()
    await syncNBAIds()
    return Response.json({ ok: true })
  } catch (e: any) {
    console.error('[sync-players]', e)
    return Response.json({ ok: false, error: e.message }, { status: 500 })
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

  const { data: existing, error: fetchErr } = await supabase
    .from('players')
    .select('id, display_name, sleeper_id')
  if (fetchErr) throw fetchErr

  const byName = new Map<string, string>()
  const bySleeperId = new Map<string, string>()
  for (const p of existing ?? []) {
    byName.set(p.display_name.toLowerCase(), p.id)
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
      status: p.status ?? null,
      injury_status: p.injury_status ?? null,
      updated_at: new Date().toISOString(),
    }

    const existingId = bySleeperId.get(p.player_id) ?? byName.get(displayName.toLowerCase())
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

  const data = await res.json() as any
  const rs = data?.resultSets?.[0]
  if (!rs) throw new Error('Unexpected NBA player index shape')

  const headers: string[] = rs.headers
  const rows: any[][] = rs.rowSet

  const pidIdx = headers.indexOf('PERSON_ID')
  const firstIdx = headers.indexOf('PLAYER_FIRST_NAME')
  const lastIdx = headers.indexOf('PLAYER_LAST_NAME')
  const statusIdx = headers.indexOf('ROSTER_STATUS')

  // Build map: normalizedName → nba person_id (active players only)
  const byNormName = new Map<string, string>()
  for (const row of rows) {
    if (row[statusIdx] !== 1) continue // skip inactive
    const fullName = `${row[firstIdx]} ${row[lastIdx]}`
    const norm = normalizeName(fullName)
    const personId = String(row[pidIdx])
    // Don't overwrite if collision — keep first match
    if (!byNormName.has(norm)) {
      byNormName.set(norm, personId)
    }
  }

  // Fetch all DB players
  const { data: players, error } = await supabase
    .from('players')
    .select('id, display_name, nba_id')
  if (error) throw error

  const updates: { id: string; nba_id: string }[] = []
  for (const p of players ?? []) {
    const norm = normalizeName(p.display_name)
    const personId = byNormName.get(norm)
    if (personId && p.nba_id !== personId) {
      updates.push({ id: p.id, nba_id: personId })
    }
  }

  for (const u of updates) {
    await supabase.from('players').update({ nba_id: u.nba_id }).eq('id', u.id)
  }

  console.log(`[sync-players] Updated nba_id for ${updates.length} players.`)
}

function normalizeName(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')   // strip generational suffixes
    .replace(/['.'\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePosition(pos: string | null | undefined): string | null {
  const map: Record<string, string> = {
    PG: 'PG', SG: 'SG', SF: 'SF', PF: 'PF', C: 'C', G: 'G', F: 'F',
  }
  return pos ? (map[pos] ?? null) : null
}
