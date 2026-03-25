import { supabase } from '../lib/supabase'

/**
 * Seeds top 4 teams from regular-season standings into the semifinal bracket.
 * Matchups: seed1 vs seed4, seed2 vs seed3.
 * Safe to call once — skips if SF matchups already exist.
 */
export async function generateSemifinals(leagueId: string): Promise<void> {
    const { data: season } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (!season) throw new Error('No active season found.')

    const { data: league } = await supabase
        .from('leagues')
        .select('playoff_start_week')
        .eq('id', leagueId)
        .single()
    if (!league) throw new Error('League not found.')

    const playoffStartWeek: number = (league as any).playoff_start_week ?? 20

    // Idempotency check
    const { count } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', season.id)
        .eq('matchup_type', 'playoff_semifinal')
    if ((count ?? 0) > 0) {
        console.log('[playoffs] Semifinals already generated.')
        return
    }

    // Compute standings from regular season
    const { data: matchups } = await supabase
        .from('matchups')
        .select('home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized')
        .eq('league_season_id', season.id)
        .eq('matchup_type', 'regular_season')

    const { data: members } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', leagueId)

    const map: Record<string, { wins: number; pf: number }> = {}
    for (const m of members ?? []) map[m.id] = { wins: 0, pf: 0 }

    for (const m of matchups ?? []) {
        const hp = Number((m as any).home_points ?? 0)
        const ap = Number((m as any).away_points ?? 0)
        if (map[(m as any).home_member_id]) map[(m as any).home_member_id].pf += hp
        if (map[(m as any).away_member_id]) map[(m as any).away_member_id].pf += ap
        if ((m as any).is_finalized && (m as any).winner_member_id) {
            if (map[(m as any).winner_member_id]) map[(m as any).winner_member_id].wins++
        }
    }

    const seeds = Object.entries(map)
        .sort(([, a], [, b]) => b.wins - a.wins || b.pf - a.pf)
        .slice(0, 4)
        .map(([id]) => id)

    if (seeds.length < 4) throw new Error('Not enough teams to seed playoffs (need 4).')

    const [s1, s2, s3, s4] = seeds

    const { error } = await supabase.from('matchups').insert([
        {
            league_id: leagueId,
            league_season_id: season.id,
            week_number: playoffStartWeek,
            matchup_type: 'playoff_semifinal',
            home_member_id: s1,
            away_member_id: s4,
        },
        {
            league_id: leagueId,
            league_season_id: season.id,
            week_number: playoffStartWeek,
            matchup_type: 'playoff_semifinal',
            home_member_id: s2,
            away_member_id: s3,
        },
    ])
    if (error) throw error
    console.log(`[playoffs] Semifinals seeded: ${s1} vs ${s4}, ${s2} vs ${s3}`)
}

/**
 * After both semis are finalized, creates the championship matchup.
 * Safe to call multiple times — skips if Final already exists.
 */
export async function advanceToFinal(leagueId: string): Promise<void> {
    const { data: season } = await supabase
        .from('league_seasons')
        .select('id')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (!season) throw new Error('No active season found.')

    const { data: league } = await supabase
        .from('leagues')
        .select('playoff_start_week')
        .eq('id', leagueId)
        .single()
    const playoffStartWeek: number = (league as any)?.playoff_start_week ?? 20

    // Idempotency check
    const { count: finalCount } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', season.id)
        .eq('matchup_type', 'playoff_final')
    if ((finalCount ?? 0) > 0) {
        console.log('[playoffs] Final already generated.')
        return
    }

    // Get semifinal results
    const { data: semis, error: semiErr } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, winner_member_id, is_finalized')
        .eq('league_season_id', season.id)
        .eq('matchup_type', 'playoff_semifinal')
    if (semiErr) throw semiErr
    if (!semis || semis.length < 2) throw new Error('Semifinals not found.')

    const unfinished = semis.filter((m) => !(m as any).is_finalized)
    if (unfinished.length > 0) throw new Error('Semifinals are not yet finalized.')

    const winners = semis.map((m) => (m as any).winner_member_id).filter(Boolean)
    if (winners.length < 2) throw new Error('Could not determine semifinal winners.')

    const { error } = await supabase.from('matchups').insert({
        league_id: leagueId,
        league_season_id: season.id,
        week_number: playoffStartWeek + 1,
        matchup_type: 'playoff_final',
        home_member_id: winners[0],
        away_member_id: winners[1],
    })
    if (error) throw error
    console.log(`[playoffs] Final created: ${winners[0]} vs ${winners[1]}`)
}
