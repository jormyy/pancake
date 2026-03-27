import { supabase } from '../_shared/supabase.ts'

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nba'
const CHUNK = 500

Deno.serve(async () => {
  try {
    await syncPlayers()
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
    const { error } = await supabase
      .from('players')
      .upsert(dedupedUpdate.slice(i, i + CHUNK), { onConflict: 'id' })
    if (error) throw error
  }

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const { error } = await supabase
      .from('players')
      .insert(toInsert.slice(i, i + CHUNK))
    if (error) console.error(`[sync-players] Insert error (chunk ${i}):`, error.message)
  }

  console.log(`[sync-players] ${dedupedUpdate.length} updated, ${toInsert.length} inserted.`)
}

function normalizePosition(pos: string | null | undefined): string | null {
  const map: Record<string, string> = {
    PG: 'PG', SG: 'SG', SF: 'SF', PF: 'PF', C: 'C', G: 'G', F: 'F',
  }
  return pos ? (map[pos] ?? null) : null
}
