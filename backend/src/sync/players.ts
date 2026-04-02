import { supabase } from '../lib/supabase'
import { fetchAllPlayers } from '../lib/sleeper'

const JUNK_INJURY_STATUSES = new Set(['Scrambled'])

function normalizeInjuryStatus(s: string | null | undefined): string | null {
    if (!s || JUNK_INJURY_STATUSES.has(s)) return null
    return s
}

/**
 * Syncs player status + injury_status from Sleeper for all players in the DB.
 * Runs every 30 minutes so injury designations are up-to-date throughout the day.
 * Full player upsert (including new players) is handled by the daily sync-players Edge Function.
 */
export async function syncPlayerStatuses(): Promise<void> {
    const raw = await fetchAllPlayers()
    const sleeperPlayers = Object.values(raw).filter(
        (p) => p.sport === 'nba' && /^\d+$/.test((p as any).player_id ?? ''),
    )
    console.log(`[syncPlayerStatuses] Fetched ${sleeperPlayers.length} NBA players from Sleeper`)

    // Build a map of sleeper_id → status fields
    const statusBySleeperId = new Map<string, { status: string | null; injury_status: string | null; nba_team: string | null }>()
    for (const p of sleeperPlayers) {
        const pid = (p as any).player_id as string
        statusBySleeperId.set(pid, {
            status: p.status ?? null,
            injury_status: normalizeInjuryStatus(p.injury_status),
            nba_team: p.team ?? null,
        })
    }

    // Fetch all DB players that have a sleeper_id
    const { data: players, error } = await supabase
        .from('players')
        .select('id, sleeper_id, status, injury_status, nba_team')
        .not('sleeper_id', 'is', null)

    if (error) throw error

    const dbPlayers = players ?? []
    console.log(`[syncPlayerStatuses] DB players with sleeper_id: ${dbPlayers.length}`)

    const toUpdate: { id: string; status: string | null; injury_status: string | null; nba_team: string | null }[] = []
    let matched = 0
    for (const p of dbPlayers) {
        const incoming = statusBySleeperId.get(p.sleeper_id!)
        if (!incoming) continue
        matched++
        if (
            incoming.status !== p.status ||
            incoming.injury_status !== p.injury_status ||
            incoming.nba_team !== p.nba_team
        ) {
            toUpdate.push({ id: p.id, ...incoming })
        }
    }
    console.log(`[syncPlayerStatuses] Matched ${matched} players, ${toUpdate.length} need updates`)

    for (const u of toUpdate) {
        const { error: updateErr } = await supabase.from('players').update({
            status: u.status,
            injury_status: u.injury_status,
            nba_team: u.nba_team,
            updated_at: new Date().toISOString(),
        }).eq('id', u.id)
        if (updateErr) console.error(`[syncPlayerStatuses] Update failed for ${u.id}:`, updateErr.message)
    }

    console.log(`[syncPlayerStatuses] Done. Updated ${toUpdate.length} player statuses.`)
}
