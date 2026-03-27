import { supabase } from '../lib/supabase'
import { fetchAllPlayers } from '../lib/sleeper'
import { CONFIG } from '../config'

export async function syncPlayers() {
    console.log('[sync] Fetching players from Sleeper...')
    const raw = await fetchAllPlayers()

    const sleeperPlayers = Object.values(raw).filter(
        (p) => p.sport === 'nba' && (p.first_name || p.last_name),
    )

    // Load existing players for name-matching (bootstrap sleeper_id population)
    const { data: existing, error: fetchErr } = await supabase
        .from('players')
        .select('id, display_name, sleeper_id')
    if (fetchErr) throw fetchErr

    const byName = new Map<string, string>() // display_name lower → player.id
    const bySleeperId = new Map<string, string>() // sleeper_id → player.id
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

    // Deduplicate toUpdate by id (multiple Sleeper entries can name-match the same player)
    const seenIds = new Map<string, any>()
    for (const p of toUpdate) seenIds.set(p.id, p)
    const dedupedUpdate = Array.from(seenIds.values())

    // Update existing players
    for (let i = 0; i < dedupedUpdate.length; i += CONFIG.UPSERT_CHUNK_SIZE) {
        const { error } = await supabase
            .from('players')
            .upsert(dedupedUpdate.slice(i, i + CONFIG.UPSERT_CHUNK_SIZE), { onConflict: 'id' })
        if (error) throw error
    }

    // Insert new players
    for (let i = 0; i < toInsert.length; i += CONFIG.UPSERT_CHUNK_SIZE) {
        const { error } = await supabase
            .from('players')
            .insert(toInsert.slice(i, i + CONFIG.UPSERT_CHUNK_SIZE))
        if (error) console.error(`[sync] Insert error (chunk ${i}):`, error.message)
    }

    console.log(`[sync] Players: ${toUpdate.length} updated, ${toInsert.length} inserted.`)
}

function normalizePosition(pos: string | null | undefined): string | null {
    const map: Record<string, string> = {
        PG: 'PG', SG: 'SG', SF: 'SF', PF: 'PF', C: 'C', G: 'G', F: 'F',
    }
    return pos ? (map[pos] ?? null) : null
}
