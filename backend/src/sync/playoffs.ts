import { supabase } from '../lib/supabase'
import { CONFIG } from '../config'
import type { Database } from '../types/database'

type MatchupInsert = Database['public']['Tables']['matchups']['Insert']

type PlayoffSeed = {
    memberId: string
    wins: number
    pointsFor: number
    maxPossiblePoints: number
    pointsAgainst: number
}

type SeasonContext = {
    seasonId: string
    playoffStartWeek: number
}

async function getSeasonContext(leagueId: string): Promise<SeasonContext> {
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

    return {
        seasonId: season.id,
        playoffStartWeek: league.playoff_start_week ?? CONFIG.DEFAULT_PLAYOFF_START_WEEK,
    }
}

async function getPlayoffSeeds(leagueId: string, leagueSeasonId: string): Promise<PlayoffSeed[]> {
    const { data: matchups, error: matchupErr } = await supabase
        .from('matchups')
        .select('home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized')
        .eq('league_season_id', leagueSeasonId)
        .eq('matchup_type', 'regular_season')
    if (matchupErr) throw matchupErr

    const { data: members, error: memberErr } = await supabase
        .from('league_members')
        .select('id')
        .eq('league_id', leagueId)
    if (memberErr) throw memberErr

    const stats = new Map<string, PlayoffSeed>()
    for (const member of members ?? []) {
        stats.set(member.id, {
            memberId: member.id,
            wins: 0,
            pointsFor: 0,
            maxPossiblePoints: 0,
            pointsAgainst: 0,
        })
    }

    for (const matchup of matchups ?? []) {
        const home = stats.get(matchup.home_member_id)
        const away = stats.get(matchup.away_member_id)
        const homePoints = Number(matchup.home_points ?? 0)
        const awayPoints = Number(matchup.away_points ?? 0)

        if (home) {
            home.pointsFor += homePoints
            home.pointsAgainst += awayPoints
            home.maxPossiblePoints += Number(matchup.home_max_possible_points ?? 0)
        }
        if (away) {
            away.pointsFor += awayPoints
            away.pointsAgainst += homePoints
            away.maxPossiblePoints += Number(matchup.away_max_possible_points ?? 0)
        }
        if (matchup.is_finalized && matchup.winner_member_id) {
            const winner = stats.get(matchup.winner_member_id)
            if (winner) winner.wins += 1
        }
    }

    const sorted = [...stats.values()].sort((a, b) => (
        b.wins - a.wins ||
        b.pointsFor - a.pointsFor ||
        b.maxPossiblePoints - a.maxPossiblePoints ||
        a.pointsAgainst - b.pointsAgainst ||
        a.memberId.localeCompare(b.memberId)
    ))

    // Honor RESOLVED RPS tiebreakers: for adjacent identical-metric pairs, put the
    // completed-challenge winner first (deterministic memberId order is the
    // fallback when a tie was never played). This is what makes RPS results
    // actually affect seeding instead of being write-only.
    const { data: rps } = await supabase
        .from('rps_challenges')
        .select('member_a_id, member_b_id, winner_member_id')
        .eq('league_season_id', leagueSeasonId)
        .not('winner_member_id', 'is', null)
    const winnerByPair = new Map<string, string>()
    for (const c of rps ?? []) {
        if (c.winner_member_id) winnerByPair.set(rpsPairKey(c.member_a_id, c.member_b_id), c.winner_member_id)
    }
    for (let i = 0; i + 1 < sorted.length; i++) {
        if (
            sameTiebreaker(sorted[i], sorted[i + 1]) &&
            winnerByPair.get(rpsPairKey(sorted[i].memberId, sorted[i + 1].memberId)) === sorted[i + 1].memberId
        ) {
            ;[sorted[i], sorted[i + 1]] = [sorted[i + 1], sorted[i]]
        }
    }
    return sorted
}

function rpsPairKey(a: string, b: string): string {
    return [a, b].sort().join('|')
}

function sameTiebreaker(a: PlayoffSeed, b: PlayoffSeed): boolean {
    return a.wins === b.wins &&
        a.pointsFor === b.pointsFor &&
        a.maxPossiblePoints === b.maxPossiblePoints &&
        a.pointsAgainst === b.pointsAgainst
}

// Record unresolved standings ties (including the bubble: the last team IN vs the
// first team OUT) as RPS challenges, deduped against existing challenges. This is
// NON-BLOCKING: seeding always proceeds deterministically, and a resolved RPS is
// honored by getPlayoffSeeds — so a tie can never deadlock playoff generation.
async function ensureRpsChallengesForTies(
    leagueId: string,
    leagueSeasonId: string,
    seeds: PlayoffSeed[],
    playoffSize: number,
): Promise<void> {
    // playoffSize + 1 so a tie for the FINAL qualifying spot is also captured.
    const relevantSeeds = seeds.slice(0, playoffSize + 1)
    const tiedPairs: Array<[string, string]> = []
    let index = 0
    while (index < relevantSeeds.length) {
        let next = index + 1
        while (next < relevantSeeds.length && sameTiebreaker(relevantSeeds[index], relevantSeeds[next])) {
            next += 1
        }
        for (let i = index; i + 1 < next; i += 2) {
            tiedPairs.push([relevantSeeds[i].memberId, relevantSeeds[i + 1].memberId])
        }
        index = next > index + 1 ? next : index + 1
    }
    if (tiedPairs.length === 0) return

    const { data: existing, error: existingErr } = await supabase
        .from('rps_challenges')
        .select('member_a_id, member_b_id')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
    if (existingErr) throw existingErr
    const existingPairs = new Set((existing ?? []).map((c) => rpsPairKey(c.member_a_id, c.member_b_id)))

    const rows = tiedPairs
        .filter(([a, b]) => !existingPairs.has(rpsPairKey(a, b)))
        .map(([a, b]) => ({
            league_id: leagueId,
            league_season_id: leagueSeasonId,
            member_a_id: a,
            member_b_id: b,
            status: 'pending' as const,
            context: 'standings_playoff_tiebreaker',
        }))
    if (rows.length === 0) return
    const { error: insertErr } = await supabase.from('rps_challenges').insert(rows)
    if (insertErr) throw insertErr
}

/**
 * Seeds playoff teams from regular-season standings.
 * Four-team leagues get a top-four semifinal bracket.
 * Larger leagues get a top-six bracket with seeds 1 and 2 on bye.
 * Safe to call once — skips if SF matchups already exist.
 */
export async function generateSemifinals(leagueId: string): Promise<void> {
    const { seasonId, playoffStartWeek } = await getSeasonContext(leagueId)

    // Idempotency check
    const { count } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', seasonId)
        .in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal'])
    if ((count ?? 0) > 0) {
        console.log('[playoffs] Playoff bracket already generated.')
        return
    }

    const seeds = await getPlayoffSeeds(leagueId, seasonId)
    if (seeds.length < 4) throw new Error('Not enough teams to seed playoffs (need 4).')
    const playoffSize = seeds.length >= 10 ? 6 : 4
    // Record any unresolved standings ties (non-blocking); seeds are already
    // ordered deterministically and honor any RESOLVED RPS result, so the bracket
    // always generates — no deadlock on a tie.
    await ensureRpsChallengesForTies(leagueId, seasonId, seeds, playoffSize)

    const seededMemberIds = seeds.slice(0, playoffSize).map((seed) => seed.memberId)

    const rows: MatchupInsert[] = playoffSize >= 6
        ? [
            {
                league_id: leagueId,
                league_season_id: seasonId,
                week_number: playoffStartWeek,
                matchup_type: 'playoff_quarterfinal' as const,
                home_member_id: seededMemberIds[2],
                away_member_id: seededMemberIds[5],
            },
            {
                league_id: leagueId,
                league_season_id: seasonId,
                week_number: playoffStartWeek,
                matchup_type: 'playoff_quarterfinal' as const,
                home_member_id: seededMemberIds[3],
                away_member_id: seededMemberIds[4],
            },
        ]
        : [
            {
                league_id: leagueId,
                league_season_id: seasonId,
                week_number: playoffStartWeek,
                matchup_type: 'playoff_semifinal' as const,
                home_member_id: seededMemberIds[0],
                away_member_id: seededMemberIds[3],
            },
            {
                league_id: leagueId,
                league_season_id: seasonId,
                week_number: playoffStartWeek,
                matchup_type: 'playoff_semifinal' as const,
                home_member_id: seededMemberIds[1],
                away_member_id: seededMemberIds[2],
            },
        ]

    const { error } = await supabase.from('matchups').insert(rows)
    if (error) throw error
    console.log(`[playoffs] Seeded ${rows.length} playoff matchup(s)`)
}

/**
 * After both semis are finalized, creates the championship matchup.
 * Safe to call multiple times — skips if Final already exists.
 */
export async function advanceToFinal(leagueId: string): Promise<void> {
    const { seasonId, playoffStartWeek } = await getSeasonContext(leagueId)

    // Idempotency check
    const { count: finalCount } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_final')
    if ((finalCount ?? 0) > 0) {
        console.log('[playoffs] Final already generated.')
        return
    }

    // Order by insertion order (created_at, then id) so QF winners map deterministically
    // to the seeds they faced. generateSemifinals inserts QFs in this order:
    //   QF[0] = seed3 vs seed6
    //   QF[1] = seed4 vs seed5
    // Standard bracket convention: seed 1 plays winner(4v5), seed 2 plays winner(3v6).
    // So below we pair seeds[0] ↔ qfWinners[1] and seeds[1] ↔ qfWinners[0].
    const { data: quarterfinals, error: qfErr } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at')
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_quarterfinal')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    if (qfErr) throw qfErr

    if ((quarterfinals ?? []).length > 0) {
        const { count: semiCount } = await supabase
            .from('matchups')
            .select('id', { count: 'exact', head: true })
            .eq('league_season_id', seasonId)
            .eq('matchup_type', 'playoff_semifinal')
        if ((semiCount ?? 0) === 0) {
            const unfinished = (quarterfinals ?? []).filter((m) => !m.is_finalized)
            if (unfinished.length > 0) throw new Error('Quarterfinals are not yet finalized.')

            const seeds = await getPlayoffSeeds(leagueId, seasonId)
            const qfWinners = (quarterfinals ?? []).map((m) => m.winner_member_id).filter((id): id is string => Boolean(id))
            if (qfWinners.length < 2) throw new Error('Could not determine quarterfinal winners.')

            const { error: semiInsertErr } = await supabase.from('matchups').insert([
                {
                    league_id: leagueId,
                    league_season_id: seasonId,
                    week_number: playoffStartWeek + 1,
                    matchup_type: 'playoff_semifinal',
                    home_member_id: seeds[0].memberId,
                    away_member_id: qfWinners[1],
                },
                {
                    league_id: leagueId,
                    league_season_id: seasonId,
                    week_number: playoffStartWeek + 1,
                    matchup_type: 'playoff_semifinal',
                    home_member_id: seeds[1].memberId,
                    away_member_id: qfWinners[0],
                },
            ])
            if (semiInsertErr) throw semiInsertErr
            console.log('[playoffs] Semifinals created from quarterfinal winners.')
            return
        }
    }

    // Get semifinal results
    const { data: semis, error: semiErr } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, winner_member_id, is_finalized')
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_semifinal')
    if (semiErr) throw semiErr
    if (!semis || semis.length < 2) throw new Error('Semifinals not found.')

    const unfinished = semis.filter((m) => !m.is_finalized)
    if (unfinished.length > 0) throw new Error('Semifinals are not yet finalized.')

    const winners = semis.map((m) => m.winner_member_id).filter((id): id is string => Boolean(id))
    if (winners.length < 2) throw new Error('Could not determine semifinal winners.')

    const { error } = await supabase.from('matchups').insert({
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: playoffStartWeek + ((quarterfinals ?? []).length > 0 ? 2 : 1),
        matchup_type: 'playoff_final',
        home_member_id: winners[0],
        away_member_id: winners[1],
    })
    if (error) throw error
    console.log(`[playoffs] Final created: ${winners[0]} vs ${winners[1]}`)
}
