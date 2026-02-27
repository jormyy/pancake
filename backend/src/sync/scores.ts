import { supabase } from '../lib/supabase'
import { calculateFantasyPoints, getWeekNumberForDate } from '../lib/scoring'

// Sums fantasy points for all active (non-IR) roster players
// for a given member across all games in a week.
async function calcMemberWeekPoints(
    memberId: string,
    leagueSeasonId: string,
    seasonYear: number,
    weekNumber: number,
    settings: Record<string, number>,
): Promise<number> {
    const { data: roster } = await supabase
        .from('roster_players')
        .select('player_id')
        .eq('member_id', memberId)
        .eq('league_season_id', leagueSeasonId)
        .eq('is_on_ir', false)

    if (!roster?.length) return 0
    const playerIds = roster.map((r) => r.player_id)

    const { data: stats } = await supabase
        .from('player_game_stats')
        .select(
            'points,rebounds,assists,steals,blocks,turnovers,' +
                'three_pointers_made,double_double,triple_double,did_not_play',
        )
        .in('player_id', playerIds)
        .eq('season_year', seasonYear)
        .eq('week_number', weekNumber)

    return parseFloat(
        (stats ?? []).reduce((sum, s) => sum + calculateFantasyPoints(s, settings), 0).toFixed(2),
    )
}

// If all games in a week are finished, mark matchups as finalized.
async function finalizeWeekIfComplete(
    leagueId: string,
    leagueSeasonId: string,
    weekNumber: number,
) {
    const { count: pendingGames } = await supabase
        .from('nba_games')
        .select('id', { count: 'exact', head: true })
        .eq('week_number', weekNumber)
        .neq('status', 'Final')

    if ((pendingGames ?? 0) > 0) return // week not done yet

    const { data: matchups } = await supabase
        .from('matchups')
        .select('id, home_member_id, away_member_id, home_points, away_points')
        .eq('league_id', leagueId)
        .eq('league_season_id', leagueSeasonId)
        .eq('week_number', weekNumber)
        .eq('is_finalized', false)

    if (!matchups?.length) return

    for (const m of matchups) {
        const homePoints = Number(m.home_points ?? 0)
        const awayPoints = Number(m.away_points ?? 0)
        const winnerId = homePoints >= awayPoints ? m.home_member_id : m.away_member_id

        await supabase
            .from('matchups')
            .update({
                winner_member_id: winnerId,
                is_finalized: true,
                finalized_at: new Date().toISOString(),
            })
            .eq('id', m.id)
    }

    console.log(`[scores] Finalized week ${weekNumber} for league ${leagueId}`)
}

// Main sync: updates live scores for all current-week matchups across all leagues.
export async function syncScores() {
    const { data: seasons, error: sErr } = await supabase
        .from('league_seasons')
        .select('id, league_id, season_year, leagues ( scoring_settings, playoff_start_week )')
        .eq('is_current', true)
    if (sErr) throw sErr
    if (!seasons?.length) return

    for (const season of seasons) {
        const league = season.leagues as any
        const settings: Record<string, number> = league?.scoring_settings ?? {}
        const playoffStart: number = league?.playoff_start_week ?? 20
        const regularSeasonWeeks = playoffStart - 1

        const weekNumber = await getWeekNumberForDate(new Date(), season.season_year)
        if (!weekNumber) {
            console.log(`[scores] No current week for season ${season.season_year}`)
            continue
        }
        if (weekNumber > regularSeasonWeeks) {
            console.log(`[scores] Week ${weekNumber} is in playoffs — skipping regular-season sync`)
            continue
        }

        console.log(`[scores] Syncing week ${weekNumber} for league ${season.league_id}`)

        const { data: matchups, error: mErr } = await supabase
            .from('matchups')
            .select('id, home_member_id, away_member_id')
            .eq('league_id', season.league_id)
            .eq('league_season_id', season.id)
            .eq('week_number', weekNumber)
            .eq('is_finalized', false)
        if (mErr) throw mErr

        if (!matchups?.length) {
            console.log(`[scores] No open matchups for week ${weekNumber}`)
            continue
        }

        for (const matchup of matchups) {
            const [homePoints, awayPoints] = await Promise.all([
                calcMemberWeekPoints(
                    matchup.home_member_id,
                    season.id,
                    season.season_year,
                    weekNumber,
                    settings,
                ),
                calcMemberWeekPoints(
                    matchup.away_member_id,
                    season.id,
                    season.season_year,
                    weekNumber,
                    settings,
                ),
            ])

            await supabase
                .from('matchups')
                .update({ home_points: homePoints, away_points: awayPoints })
                .eq('id', matchup.id)
        }

        // Finalize the previous week if all its games are done
        if (weekNumber > 1) {
            await finalizeWeekIfComplete(season.league_id, season.id, weekNumber - 1)
        }
    }

    console.log('[scores] Sync complete.')
}
