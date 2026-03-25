import { supabase } from '../lib/supabase'

// Standard round-robin: fix teams[0], rotate the rest each round.
// Returns an array of rounds, each round being a list of home/away pairs.
function roundRobinRounds(ids: string[]): { home: string; away: string }[][] {
    const teams = ids.length % 2 === 0 ? [...ids] : [...ids, '__bye__']
    const n = teams.length
    const rounds: { home: string; away: string }[][] = []

    for (let r = 0; r < n - 1; r++) {
        const fixed = teams[0]
        const rotating = teams.slice(1)
        const rotated = [...rotating.slice(r), ...rotating.slice(0, r)]
        const circle = [fixed, ...rotated]

        const pairings: { home: string; away: string }[] = []
        for (let i = 0; i < n / 2; i++) {
            const home = circle[i]
            const away = circle[n - 1 - i]
            if (home !== '__bye__' && away !== '__bye__') {
                pairings.push({ home, away })
            }
        }
        rounds.push(pairings)
    }
    return rounds
}

// Generates the full regular-season H2H schedule for a league.
// Safe to call multiple times — skips if matchups already exist for the season.
export async function generateMatchups(
    leagueId: string,
    leagueSeasonId: string,
    regularSeasonWeeks: number,
    force = false,
) {
    const { data: members, error: mErr } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', leagueId)
    if (mErr) throw mErr

    if (!members || members.length < 2) {
        console.log('[matchups] Not enough members to generate schedule.')
        return
    }

    // Idempotency check (skip unless force)
    const { count } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', leagueSeasonId)
    if ((count ?? 0) > 0) {
        if (!force) {
            console.log('[matchups] Schedule already generated for this season.')
            return
        }
        console.log('[matchups] Force-regenerating — deleting existing matchups...')
        await supabase.from('matchups').delete().eq('league_season_id', leagueSeasonId)
    }

    const memberIds = members.map((m) => m.id)
    const rounds = roundRobinRounds(memberIds)

    const rows: any[] = []
    for (let week = 1; week <= regularSeasonWeeks; week++) {
        const round = rounds[(week - 1) % rounds.length]
        for (const { home, away } of round) {
            rows.push({
                league_id: leagueId,
                league_season_id: leagueSeasonId,
                week_number: week,
                home_member_id: home,
                away_member_id: away,
                matchup_type: 'regular_season',
            })
        }
    }

    const { error } = await supabase.from('matchups').insert(rows)
    if (error) throw error
    console.log(`[matchups] Generated ${rows.length} matchups for ${regularSeasonWeeks} weeks.`)
}

// Generates matchups for ALL active league seasons that don't have one yet.
export async function generateAllMatchups(force = false) {
    const { data: seasons, error } = await supabase
        .from('league_seasons')
        .select('id, league_id, leagues ( playoff_start_week )')
        .eq('is_current', true)
    if (error) throw error

    for (const season of seasons ?? []) {
        const league = season.leagues as any
        const playoffStart: number = league?.playoff_start_week ?? 20
        const regularSeasonWeeks = playoffStart - 1
        await generateMatchups(season.league_id, season.id, regularSeasonWeeks, force)
    }
}
