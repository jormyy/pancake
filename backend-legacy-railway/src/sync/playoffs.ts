import { createHash } from 'node:crypto'
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
    tieToken: string
}

type SeasonContext = {
    seasonId: string
    seasonYear: number
    playoffStartWeek: number
}

async function getSeasonContext(leagueId: string): Promise<SeasonContext> {
    const { data: season, error: seasonErr } = await supabase
        .from('league_seasons')
        .select('id, season_year')
        .eq('league_id', leagueId)
        .eq('is_current', true)
        .single()
    if (seasonErr) throw seasonErr
    if (!season) throw new Error('No active season found.')

    const { data: league, error: leagueErr } = await supabase
        .from('leagues')
        .select('playoff_start_week')
        .eq('id', leagueId)
        .single()
    if (leagueErr) throw leagueErr
    if (!league) throw new Error('League not found.')

    return {
        seasonId: season.id,
        seasonYear: season.season_year,
        playoffStartWeek: league.playoff_start_week ?? CONFIG.DEFAULT_PLAYOFF_START_WEEK,
    }
}

async function assertRegularSeasonFinalized(leagueSeasonId: string, playoffStartWeek: number): Promise<void> {
    const { data: unfinalized, error } = await supabase
        .from('matchups')
        .select('id')
        .eq('league_season_id', leagueSeasonId)
        .eq('matchup_type', 'regular_season')
        .lt('week_number', playoffStartWeek)
        .eq('is_finalized', false)
        .limit(1)
    if (error) throw error
    if ((unfinalized ?? []).length > 0) {
        throw new Error('Regular season matchups must be finalized before generating playoffs.')
    }
}

async function getPlayoffSeeds(
    leagueId: string,
    leagueSeasonId: string,
    playoffStartWeek: number,
): Promise<PlayoffSeed[]> {
    const { data: matchups, error: matchupErr } = await supabase
        .from('matchups')
        .select('home_member_id, away_member_id, home_points, away_points, home_max_possible_points, away_max_possible_points, winner_member_id, is_finalized')
        .eq('league_season_id', leagueSeasonId)
        .eq('matchup_type', 'regular_season')
        .lt('week_number', playoffStartWeek)
        .eq('is_finalized', true)
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
            tieToken: deterministicTiebreakerToken(leagueSeasonId, member.id),
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

    return [...stats.values()].sort(comparePlayoffSeeds)
}

function deterministicTiebreakerToken(leagueSeasonId: string, memberId: string): string {
    return createHash('sha256').update(`${leagueSeasonId}:${memberId}`).digest('hex')
}

function compareStandingsMetrics(a: PlayoffSeed, b: PlayoffSeed): number {
    return b.wins - a.wins ||
        b.pointsFor - a.pointsFor ||
        b.maxPossiblePoints - a.maxPossiblePoints ||
        a.pointsAgainst - b.pointsAgainst
}

function comparePlayoffSeeds(a: PlayoffSeed, b: PlayoffSeed): number {
    return compareStandingsMetrics(a, b) ||
        a.tieToken.localeCompare(b.tieToken) ||
        a.memberId.localeCompare(b.memberId)
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

type TiebreakerPair = {
    memberAId: string
    memberBId: string
    winnerMemberId: string
}

function relevantTiebreakerPairs(seeds: PlayoffSeed[], playoffSize: number): TiebreakerPair[] {
    // Include the full exact-tie group whenever that group overlaps a playoff
    // seed. That covers ties inside the bracket and ties crossing the final
    // qualifying spot without truncating larger tied groups.
    const tiedPairs: TiebreakerPair[] = []
    let index = 0
    while (index < seeds.length) {
        let next = index + 1
        while (next < seeds.length && sameTiebreaker(seeds[index], seeds[next])) {
            next += 1
        }
        const groupOverlapsPlayoffField = index < playoffSize
        if (!groupOverlapsPlayoffField) break
        for (let i = index; i < next; i += 1) {
            for (let j = i + 1; j < next; j += 1) {
                const a = seeds[i]
                const b = seeds[j]
                tiedPairs.push({
                    memberAId: a.memberId,
                    memberBId: b.memberId,
                    winnerMemberId: comparePlayoffSeeds(a, b) <= 0 ? a.memberId : b.memberId,
                })
            }
        }
        index = next > index + 1 ? next : index + 1
    }
    return tiedPairs
}

// Exact standings ties are resolved by the season-scoped deterministic token in
// comparePlayoffSeeds. Record the resulting pairwise decisions as completed
// tiebreaker audit rows so standings-tiebreaker scenarios are inspectable without
// depending on a separate browser RPS workflow.
async function recordTiebreakerAuditRows(
    leagueId: string,
    leagueSeasonId: string,
    seeds: PlayoffSeed[],
    playoffSize: number,
): Promise<void> {
    const tiedPairs = relevantTiebreakerPairs(seeds, playoffSize)
    if (tiedPairs.length === 0) return

    const { data: existing, error: existingErr } = await supabase
        .from('rps_challenges')
        .select('id, member_a_id, member_b_id, winner_member_id, status')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('context', 'standings_playoff_tiebreaker')
    if (existingErr) throw existingErr
    const existingByPair = new Map(
        (existing ?? []).map((challenge) => [rpsPairKey(challenge.member_a_id, challenge.member_b_id), challenge]),
    )
    const resolvedAt = new Date().toISOString()

    const rows = tiedPairs
        .filter((pair) => !existingByPair.has(rpsPairKey(pair.memberAId, pair.memberBId)))
        .map((pair) => ({
            league_id: leagueId,
            league_season_id: leagueSeasonId,
            member_a_id: pair.memberAId,
            member_b_id: pair.memberBId,
            winner_member_id: pair.winnerMemberId,
            status: 'completed' as const,
            context: 'standings_playoff_tiebreaker',
            resolved_at: resolvedAt,
        }))
    if (rows.length > 0) {
        const { error: insertErr } = await supabase.from('rps_challenges').insert(rows)
        if (insertErr) throw insertErr
    }

    for (const pair of tiedPairs) {
        const existingChallenge = existingByPair.get(rpsPairKey(pair.memberAId, pair.memberBId))
        if (
            !existingChallenge ||
            (existingChallenge.status === 'completed' && existingChallenge.winner_member_id === pair.winnerMemberId)
        ) {
            continue
        }
        const { error: updateErr } = await supabase
            .from('rps_challenges')
            .update({
                winner_member_id: pair.winnerMemberId,
                member_a_choice: null,
                member_b_choice: null,
                status: 'completed' as const,
                resolved_at: resolvedAt,
            })
            .eq('id', existingChallenge.id)
        if (updateErr) throw updateErr
    }
}

async function assertPlayoffWeeksAvailable(
    seasonYear: number,
    playoffStartWeek: number,
    playoffRounds: number,
): Promise<void> {
    const { data: lastWeek, error } = await supabase
        .from('season_weeks')
        .select('week_number')
        .eq('season_year', seasonYear)
        .order('week_number', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (error) throw error

    const lastWeekNumber = Number(lastWeek?.week_number ?? 0)
    const finalPlayoffWeek = playoffStartWeek + playoffRounds - 1
    if (!Number.isFinite(lastWeekNumber) || lastWeekNumber < finalPlayoffWeek) {
        throw new Error('Playoff start week does not leave enough season weeks for every playoff round.')
    }
}

/**
 * Seeds playoff teams from regular-season standings.
 * Four-team leagues get a top-four semifinal bracket.
 * Larger leagues get a top-six bracket with seeds 1 and 2 on bye.
 * Safe to call once — skips if SF matchups already exist.
 */
export async function generateSemifinals(leagueId: string): Promise<void> {
    const { seasonId, seasonYear, playoffStartWeek } = await getSeasonContext(leagueId)
    await assertRegularSeasonFinalized(seasonId, playoffStartWeek)

    // Idempotency check
    const { count, error: playoffCountErr } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', seasonId)
        .in('matchup_type', ['playoff_quarterfinal', 'playoff_semifinal'])
    if (playoffCountErr) throw playoffCountErr
    if ((count ?? 0) > 0) {
        console.log('[playoffs] Playoff bracket already generated.')
        return
    }

    const seeds = await getPlayoffSeeds(leagueId, seasonId, playoffStartWeek)
    if (seeds.length < 4) throw new Error('Not enough teams to seed playoffs (need 4).')
    const playoffSize = seeds.length >= 10 ? 6 : 4
    await assertPlayoffWeeksAvailable(seasonYear, playoffStartWeek, playoffSize >= 6 ? 3 : 2)
    await recordTiebreakerAuditRows(leagueId, seasonId, seeds, playoffSize)

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
    const { seasonId } = await getSeasonContext(leagueId)

    // Idempotency check
    const { count: finalCount, error: finalCountErr } = await supabase
        .from('matchups')
        .select('id', { count: 'exact', head: true })
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_final')
    if (finalCountErr) throw finalCountErr
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
        .select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_quarterfinal')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    if (qfErr) throw qfErr

    if ((quarterfinals ?? []).length > 0) {
        const quarterfinalWeek = Math.min(...(quarterfinals ?? []).map((m) => Number(m.week_number)))
        const { count: semiCount, error: semiCountErr } = await supabase
            .from('matchups')
            .select('id', { count: 'exact', head: true })
            .eq('league_season_id', seasonId)
            .eq('matchup_type', 'playoff_semifinal')
        if (semiCountErr) throw semiCountErr
        if ((semiCount ?? 0) === 0) {
            const unfinished = (quarterfinals ?? []).filter((m) => !m.is_finalized)
            if (unfinished.length > 0) throw new Error('Quarterfinals are not yet finalized.')

            const seeds = await getPlayoffSeeds(leagueId, seasonId, quarterfinalWeek)
            const qfWinners = (quarterfinals ?? []).map((m) => m.winner_member_id).filter((id): id is string => Boolean(id))
            if (qfWinners.length < 2) throw new Error('Could not determine quarterfinal winners.')

            const { error: semiInsertErr } = await supabase.from('matchups').insert([
                {
                    league_id: leagueId,
                    league_season_id: seasonId,
                    week_number: quarterfinalWeek + 1,
                    matchup_type: 'playoff_semifinal',
                    home_member_id: seeds[0].memberId,
                    away_member_id: qfWinners[1],
                },
                {
                    league_id: leagueId,
                    league_season_id: seasonId,
                    week_number: quarterfinalWeek + 1,
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

    // Get semifinal results in bracket insertion order. Final home/away is
    // deterministic and is also the last-resort playoff tie fallback.
    const { data: semis, error: semiErr } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, winner_member_id, is_finalized, created_at, week_number')
        .eq('league_season_id', seasonId)
        .eq('matchup_type', 'playoff_semifinal')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    if (semiErr) throw semiErr
    if (!semis || semis.length < 2) throw new Error('Semifinals not found.')

    const unfinished = semis.filter((m) => !m.is_finalized)
    if (unfinished.length > 0) throw new Error('Semifinals are not yet finalized.')

    const winners = semis.map((m) => m.winner_member_id).filter((id): id is string => Boolean(id))
    if (winners.length < 2) throw new Error('Could not determine semifinal winners.')
    const finalWeek = Math.max(...semis.map((m) => Number(m.week_number))) + 1

    const { error } = await supabase.from('matchups').insert({
        league_id: leagueId,
        league_season_id: seasonId,
        week_number: finalWeek,
        matchup_type: 'playoff_final',
        home_member_id: winners[0],
        away_member_id: winners[1],
    })
    if (error) throw error
    console.log(`[playoffs] Final created: ${winners[0]} vs ${winners[1]}`)
}
