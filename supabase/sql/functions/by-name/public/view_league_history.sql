CREATE OR REPLACE FUNCTION public.view_league_history(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; seasons jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  WITH completed AS (
    SELECT season.*, final.winner_member_id AS champion_id,
      CASE WHEN final.winner_member_id = final.home_member_id THEN final.away_member_id ELSE final.home_member_id END AS runner_up_id
    FROM public.league_seasons season
    CROSS JOIN LATERAL (
      SELECT matchup.* FROM public.matchups matchup
      WHERE matchup.league_season_id = season.id AND matchup.matchup_type = 'playoff_final'
        AND matchup.is_finalized AND NOT matchup.is_voided AND matchup.winner_member_id IS NOT NULL
      ORDER BY matchup.week_number DESC, matchup.id LIMIT 1
    ) final
    WHERE season.league_id = p_league_id
  ), records AS (
    SELECT season.id AS season_id, participant.member_id, COALESCE(member.team_name, 'Team') AS team_name,
      COALESCE(saved.wins, 0) AS wins, COALESCE(saved.losses, 0) AS losses, COALESCE(saved.ties, 0) AS ties,
      COALESCE(saved.points_for, 0) AS points_for, COALESCE(saved.points_against, 0) AS points_against,
      COALESCE(saved.max_possible_points, 0) AS max_points,
      array_position(COALESCE(season.playoff_bracket_seed_ids, season.playoff_seed_member_ids), participant.member_id) AS seed,
      season.champion_id, season.runner_up_id, cardinality(season.playoff_round_weeks) AS round_count, playoff.matchup_type AS playoff_type, playoff.playoff_round
    FROM completed season
    CROSS JOIN LATERAL (
      SELECT standing.member_id FROM public.standings standing WHERE standing.league_season_id = season.id
      UNION SELECT matchup.home_member_id FROM public.matchups matchup WHERE matchup.league_season_id = season.id AND NOT matchup.is_voided
      UNION SELECT matchup.away_member_id FROM public.matchups matchup WHERE matchup.league_season_id = season.id AND NOT matchup.is_voided
    ) participant
    JOIN public.league_members member ON member.id = participant.member_id AND member.league_id = p_league_id
    LEFT JOIN LATERAL (
      SELECT standing.* FROM public.standings standing
      WHERE standing.league_season_id = season.id AND standing.member_id = participant.member_id
      ORDER BY standing.week_number DESC LIMIT 1
    ) saved ON true
    LEFT JOIN LATERAL (
      SELECT matchup.matchup_type, COALESCE(matchup.playoff_round,
        CASE matchup.matchup_type WHEN 'playoff_final' THEN 3 WHEN 'playoff_semifinal' THEN 2 ELSE 1 END) AS playoff_round
      FROM public.matchups matchup
      WHERE matchup.league_season_id = season.id AND matchup.matchup_type <> 'regular_season'
        AND matchup.is_finalized AND NOT matchup.is_voided AND participant.member_id IN (matchup.home_member_id, matchup.away_member_id)
      ORDER BY matchup.week_number DESC, matchup.id LIMIT 1
    ) playoff ON true
  ), regular_ranked AS (
    SELECT records.*, row_number() OVER (PARTITION BY season_id ORDER BY
      (wins + 0.5 * ties) / GREATEST(wins + losses + ties, 1) DESC,
      points_for / GREATEST(wins + losses + ties, 1) DESC, max_points DESC, points_against,
      seed NULLS LAST, team_name COLLATE "en-US-x-icu", member_id) AS regular_rank
    FROM records
  ), ranked AS (
    SELECT regular_ranked.*, row_number() OVER (PARTITION BY season_id ORDER BY
      CASE member_id WHEN champion_id THEN 0 WHEN runner_up_id THEN 1 ELSE 2 END,
      playoff_round DESC NULLS LAST, regular_rank) AS final_rank
    FROM regular_ranked
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', season.id, 'year', season.season_year,
    'champion', jsonb_build_object('memberId', season.champion_id, 'teamName', COALESCE(champion.team_name, 'Team')),
    'standings', (SELECT jsonb_agg(jsonb_build_object(
      'memberId', team.member_id, 'teamName', team.team_name, 'finalRank', team.final_rank,
      'regularSeasonRank', team.regular_rank, 'wins', team.wins, 'losses', team.losses, 'ties', team.ties,
      'pointsFor', team.points_for, 'pointsAgainst', team.points_against,
      'playoffResult', CASE team.member_id WHEN season.champion_id THEN 'Champion' WHEN season.runner_up_id THEN 'Runner-up'
        ELSE CASE team.playoff_type WHEN 'playoff_semifinal' THEN 'Semifinal' WHEN 'playoff_quarterfinal' THEN
          CASE WHEN team.round_count IS NULL OR team.playoff_round = team.round_count - 2 THEN 'Quarterfinal' ELSE 'Round ' || team.playoff_round END
          ELSE CASE WHEN team.playoff_round IS NULL THEN 'Did not qualify' ELSE 'Round ' || team.playoff_round END END END
    ) ORDER BY team.final_rank) FROM ranked team WHERE team.season_id = season.id),
    'stats', jsonb_build_object('teams', (SELECT count(*) FROM ranked team WHERE team.season_id = season.id),
      'games', (SELECT count(*) FROM public.matchups matchup WHERE matchup.league_season_id = season.id
        AND matchup.matchup_type = 'regular_season' AND matchup.is_finalized AND NOT matchup.is_voided),
      'pointsFor', (SELECT COALESCE(sum(team.points_for), 0) FROM ranked team WHERE team.season_id = season.id))
  ) ORDER BY season.season_year DESC, season.id), '[]'::jsonb)
  INTO seasons FROM completed season LEFT JOIN public.league_members champion ON champion.id = season.champion_id;
  RETURN jsonb_build_object('context', context, 'seasons', seasons);
END;
$$;
