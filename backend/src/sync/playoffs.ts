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

    return [...stats.values()].sort((a, b) => (
        b.wins - a.wins ||
        b.pointsFor - a.pointsFor ||
        b.maxPossiblePoints - a.maxPossiblePoints ||
        a.pointsAgainst - b.pointsAgainst ||
        a.memberId.localeCompare(b.memberId)
    ))
}

function sameTiebreaker(a: PlayoffSeed, b: PlayoffSeed): boolean {
    return a.wins === b.wins &&
        a.pointsFor === b.pointsFor &&
        a.maxPossiblePoints === b.maxPossiblePoints &&
        a.pointsAgainst === b.pointsAgainst
}

async function createRpsChallengesForTies(
    leagueId: string,
    leagueSeasonId: string,
    seeds: PlayoffSeed[],
    playoffSize: number,
): Promise<boolean> {
    const relevantSeeds = seeds.slice(0, playoffSize)
    const tiedGroups: PlayoffSeed[][] = []
    let index = 0
    while (index < relevantSeeds.length) {
        const group = [relevantSeeds[index]]
        let next = index + 1
        while (next < relevantSeeds.length && sameTiebreaker(relevantSeeds[index], relevantSeeds[next])) {
            group.push(relevantSeeds[next])
            next += 1
        }
        if (group.length > 1) tiedGroups.push(group)
        index = next
    }

    if (tiedGroups.length === 0) return false

    const { data: existing, error: existingErr } = await supabase
        .from('rps_challenges')
        .select('id')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('status', 'pending')
        .limit(1)
    if (existingErr) throw existingErr
    if ((existing ?? []).length > 0) return true

    const rows = tiedGroups.flatMap((group) => {
        const challenges = []
        for (let i = 0; i < group.length - 1; i += 2) {
            challenges.push({
                league_id: leagueId,
                league_season_id: leagueSeasonId,
                member_a_id: group[i].memberId,
                member_b_id: group[i + 1].memberId,
                status: 'pending' as const,
                context: 'standings_playoff_tiebreaker',
            })
        }
        return challenges
    })

    if (rows.length === 0) return true
    const { error: insertErr } = await supabase.from('rps_challenges').insert(rows)
    if (insertErr) throw insertErr
    return true
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
    const playoffSize = seeds.length >= 10 ? 6 : 4
    if (seeds.length < 4) throw new Error('Not enough teams to seed playoffs (need 4).')
    if (await createRpsChallengesForTies(leagueId, seasonId, seeds, playoffSize)) {
        console.log('[playoffs] RPS tiebreaker required before playoff seeding.')
        return
    }

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
