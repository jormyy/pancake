import { supabase } from '../lib/supabase'
import { fetchAllSleeperPlayers } from '../lib/sleeper'
import { normalizeName } from '../lib/utils/nameMatch'
import { todayET } from '../lib/utils/date'

const JUNK_INJURY_STATUSES = new Set(['Scrambled'])

function normalizeInjuryStatus(s: string | null | undefined): string | null {
    if (!s || JUNK_INJURY_STATUSES.has(s)) return null
    return s
}

type StatusFields = { status: string | null; injury_status: string | null; nba_team: string | null; years_exp: number | null }

/**
 * Syncs player status + injury_status from Sleeper for all players in the DB.
 * Matches by sleeper_id first, then falls back to normalized display name for
 * players that don't have a sleeper_id set (e.g. matched by name in Edge Function).
 */
export async function syncPlayerStatuses(): Promise<void> {
    const raw = await fetchAllSleeperPlayers()
    const sleeperPlayers = Object.values(raw).filter(
        (p) => p.sport === 'nba' && /^\d+$/.test((p as any).player_id ?? ''),
    )
    console.log(`[syncPlayerStatuses] Fetched ${sleeperPlayers.length} NBA players from Sleeper`)

    const statusBySleeperId = new Map<string, StatusFields>()
    const statusByName = new Map<string, StatusFields>()
    for (const p of sleeperPlayers) {
        const pid = (p as any).player_id as string
        const fields: StatusFields = {
            status: p.status ?? null,
            injury_status: normalizeInjuryStatus(p.injury_status),
            nba_team: p.team ?? null,
            years_exp: p.years_exp ?? null,
        }
        statusBySleeperId.set(pid, fields)
        const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ')
        if (fullName) statusByName.set(normalizeName(fullName), fields)
    }

    // Fetch all DB players
    const { data: players, error } = await supabase
        .from('players')
        .select('id, display_name, sleeper_id, status, injury_status, nba_team, years_exp')

    if (error) throw error

    // Don't restore injury status for players who have already played today —
    // the stats sync correctly clears those, and Sleeper is just slow to update.
    const today = todayET()
    const { data: playedToday } = await supabase
        .from('player_game_stats')
        .select('player_id')
        .eq('did_not_play', false)
        .in('game_id',
            (await supabase.from('nba_games').select('id').eq('game_date', today)).data?.map((g: any) => g.id) ?? [],
        )
    const playedTodayIds = new Set((playedToday ?? []).map((r: any) => r.player_id as string))

    const dbPlayers = players ?? []
    const withId = dbPlayers.filter((p: any) => p.sleeper_id)
    const withoutId = dbPlayers.filter((p: any) => !p.sleeper_id)
    console.log(`[syncPlayerStatuses] DB players: ${withId.length} with sleeper_id, ${withoutId.length} name-matched`)

    const toUpdate: { id: string; fields: StatusFields }[] = []
    let matched = 0

    for (const p of withId) {
        const incoming = statusBySleeperId.get((p as any).sleeper_id)
        if (!incoming) continue
        matched++
        // Skip injury_status restore for players who already played today
        const fields = playedTodayIds.has((p as any).id) ? { ...incoming, injury_status: null } : incoming
        if (changed(fields, p as any)) toUpdate.push({ id: (p as any).id, fields })
    }

    for (const p of withoutId) {
        const incoming = statusByName.get(normalizeName((p as any).display_name))
        if (!incoming) continue
        matched++
        const fields = playedTodayIds.has((p as any).id) ? { ...incoming, injury_status: null } : incoming
        if (changed(fields, p as any)) toUpdate.push({ id: (p as any).id, fields })
    }

    console.log(`[syncPlayerStatuses] Matched ${matched} players, ${toUpdate.length} need updates`)

    for (const { id, fields } of toUpdate) {
        const { error: updateErr } = await supabase.from('players').update({
            status: fields.status,
            injury_status: fields.injury_status,
            nba_team: fields.nba_team,
            years_exp: fields.years_exp,
            updated_at: new Date().toISOString(),
        }).eq('id', id)
        if (updateErr) console.error(`[syncPlayerStatuses] Update failed for ${id}:`, updateErr.message)
    }

    console.log(`[syncPlayerStatuses] Done. Updated ${toUpdate.length} player statuses.`)
}

function changed(incoming: StatusFields, p: { status: string | null; injury_status: string | null; nba_team: string | null; years_exp?: number | null }): boolean {
    return incoming.status !== p.status || incoming.injury_status !== p.injury_status || incoming.nba_team !== p.nba_team || incoming.years_exp !== p.years_exp
}
