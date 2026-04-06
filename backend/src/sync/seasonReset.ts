import { supabase } from '../lib/supabase'

// ── Advance Season ─────────────────────────────────────────────
// Creates a new league_season, carries rosters forward, seeds
// waiver priorities and new draft pick assets, then sets league
// status to 'offseason' so the commissioner can start the
// rookie draft.
export async function advanceSeason(leagueId: string) {
    const { data: league, error: leagueErr } = await supabase
        .from('leagues')
        .select('id, status')
        .eq('id', leagueId)
        .single()
    if (leagueErr || !league) throw new Error('League not found')

    // Require there is a current season
    const { data: currentSeason, error: seasonErr } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (seasonErr || !currentSeason) throw new Error('No active season found for this league')

    const newYear = currentSeason.season_year + 1

    // Check new season doesn't already exist
    const { data: existing } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('season_year', newYear)
        .maybeSingle()
    if (existing) throw new Error(`Season ${newYear} already exists`)

    // ── 1. Mark old season as not current ─────────────────────
    await supabase
        .from('league_seasons')
        .update({ is_current: false })
        .eq('id', currentSeason.id)

    // ── 2. Create new season ───────────────────────────────────
    const { data: newSeason, error: newSeasonErr } = await supabase
        .from('league_seasons')
        .insert({ league_id: leagueId, season_year: newYear, is_current: true })
        .select()
        .single()
    if (newSeasonErr) throw newSeasonErr

    // ── 3. Carry rosters forward ───────────────────────────────
    const { data: rosterPlayers } = await supabase
        .from('roster_players')
        .select('member_id, player_id, is_on_ir')
        .eq('league_id', leagueId)
        .eq('league_season_id', currentSeason.id)

    if (rosterPlayers && rosterPlayers.length > 0) {
        await supabase.from('roster_players').insert(
            rosterPlayers.map((rp) => ({
                league_id: leagueId,
                league_season_id: newSeason.id,
                member_id: rp.member_id,
                player_id: rp.player_id,
                is_on_ir: rp.is_on_ir,
                acquired_via: 'carry_over',
            })),
        )
    }

    // ── 4. Extend pick bank 5 years out from new season ───────
    const { data: members } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', leagueId)

    if (members && members.length > 0) {
        const farYear = newYear + 5
        const pickRows: object[] = []
        for (const member of members) {
            for (const round of [1, 2, 3]) {
                pickRows.push({
                    league_id: leagueId,
                    season_year: farYear,
                    round,
                    original_owner_id: member.id,
                    current_owner_id: member.id,
                })
            }
        }
        // Insert new picks (ignore if already exist)
        await (supabase as any).from('draft_picks').upsert(pickRows, {
            onConflict: 'league_id,season_year,round,original_owner_id',
            ignoreDuplicates: true,
        })
    }

    // ── 5. Seed waiver priorities for new season ───────────────
    // Worst last-season record → priority 1 (highest priority)
    const { data: standings } = await supabase
        .from('standings')
        .select('member_id, wins, losses, points_for')
        .eq('league_id', leagueId)
        .eq('league_season_id', currentSeason.id)
        .order('week_number', { ascending: false })
        .limit(200)

    let priorityOrder: string[] = []
    if (standings && standings.length > 0) {
        const latestByMember = new Map<string, typeof standings[0]>()
        for (const s of standings) {
            if (!latestByMember.has(s.member_id)) latestByMember.set(s.member_id, s)
        }
        // Worst first: fewest wins, fewest points
        priorityOrder = Array.from(latestByMember.values())
            .sort((a, b) => a.wins - b.wins || a.points_for - b.points_for)
            .map((s) => s.member_id)
    }

    if (priorityOrder.length === 0) {
        priorityOrder = (members ?? []).map((m) => m.id)
    }

    if (priorityOrder.length > 0) {
        await supabase.from('waiver_priorities').insert(
            priorityOrder.map((memberId, i) => ({
                league_id: leagueId,
                league_season_id: newSeason.id,
                member_id: memberId,
                priority: i + 1,
            })),
        )
    }

    // ── 6. Set league to offseason ─────────────────────────────
    await supabase.from('leagues').update({ status: 'offseason' }).eq('id', leagueId)

    console.log(`[seasonReset] League ${leagueId} advanced from ${currentSeason.season_year} → ${newYear}`)
    return { newSeasonId: newSeason.id, newYear }
}
