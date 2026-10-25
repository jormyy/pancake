import { supabase } from '../_shared/supabase.ts'
import { fetchWithRetry } from '../_shared/retry.ts'
import { AMBIGUOUS, normalizeName, setUnique } from '../_shared/nameMatch.ts'
import { resolvePlayerImports } from '../_shared/playerImports.ts'
import { fetchAllPlayers } from './players.ts'

const NBA_CDN_BASE_URL = Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
const NBA_PLAYER_INDEX_URL = `${NBA_CDN_BASE_URL}/staticData/playerIndex.json`
const CHUNK = 500

// Fetch the NBA CDN player index and populate nba_id for any players missing it.
// The index includes all active NBA players with their PERSON_ID, first name, and last name
// (last name includes suffix, e.g. "Jackson Jr.", "Payton II").
export async function syncNBAIds(): Promise<{ mapped: number; merged: number; failures: string[] }> {
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

  const failures: string[] = []
  let mergedBeforeUpdate = 0
  let mapped = 0
  for (let offset = 0; offset < updates.length; offset += CHUNK) {
    const chunk = updates.slice(offset, offset + CHUNK)
    const { results } = await resolvePlayerImports('nba_index', chunk.map((update) => ({
      player_id: update.id, provider_id: update.nba_id,
      expected_display_name: update.expected_display_name, name_match: update.name_match,
    })))
    for (const row of results) {
      if (!row.player_id) {
        failures.push(`NBA index provider ${chunk[row.index].nba_id}: ${row.action}`)
        continue
      }
      if (row.player_id !== chunk[row.index].id) mergedBeforeUpdate++
      else mapped++
    }
  }
  console.log(`[sync-players] Updated nba_id for ${mapped} players; merged ${mergedBeforeUpdate} duplicate rows before update.`)

  // Merge any players that ended up with the same nba_id (same real person, two DB rows)
  const { error: mergeErr } = await supabase.rpc('merge_duplicate_players')
  if (mergeErr) failures.push(`merge_duplicate_players: ${mergeErr.message}`)
  else console.log('[sync-players] Dedup complete.')

  return { mapped, merged: mergedBeforeUpdate, failures }
}
