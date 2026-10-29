CREATE OR REPLACE FUNCTION public.view_league_schedule(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH context AS MATERIALIZED (
    SELECT public.view_context(p_league_id, p_member_id, p_params - ARRAY['weekNumber', 'seasonYear', 'date']) AS value
  ), settings AS (
    SELECT value,
      COALESCE(value->'season'->'skipped_weeks', '[]'::jsonb) AS skipped_weeks,
      COALESCE((value->'season'->>'playoff_start_week')::integer, (value->'league'->>'playoff_start_week')::integer) AS playoff_start,
      COALESCE((SELECT sum(weeks::integer) FROM jsonb_array_elements_text(NULLIF(value->'season'->'playoff_round_weeks', 'null')) weeks),
        CASE WHEN value->'league'->>'playoff_entrants' IS NOT NULL THEN
          (SELECT sum(weeks::integer) FROM jsonb_array_elements_text(NULLIF(value->'league'->'playoff_round_lengths', 'null')) weeks) END,
        (value->'league'->>'playoff_total_weeks')::integer,
        (SELECT CASE WHEN count(*) >= 10 THEN 3 ELSE 2 END FROM public.league_members WHERE league_id = p_league_id)) AS playoff_weeks
    FROM context
  ), matchups AS MATERIALIZED (
    SELECT m.week_number, COALESCE(m.end_week_number, m.week_number) AS end_week, m.id,
      CASE WHEN m.home_member_id = p_member_id THEN m.away_member_id ELSE m.home_member_id END AS opponent_id,
      CASE WHEN m.home_member_id = p_member_id THEN m.home_points ELSE m.away_points END AS my_points,
      CASE WHEN m.home_member_id = p_member_id THEN m.away_points ELSE m.home_points END AS opponent_points,
      m.is_finalized, m.winner_member_id
    FROM public.matchups m CROSS JOIN context
    WHERE m.league_id = p_league_id AND m.league_season_id = (context.value->>'seasonId')::uuid
      AND NOT m.is_voided AND p_member_id IN (m.home_member_id, m.away_member_id)
  ), weeks AS (
    SELECT DISTINCT ON (week.week_number) week.week_number, member.team_name,
      (settings.value->>'today')::date BETWEEN week.week_start AND week.week_end AS is_current,
      CASE WHEN settings.skipped_weeks @> jsonb_build_array(week.week_number) THEN 'skipped'
        WHEN matchup.is_finalized THEN
          CASE WHEN matchup.winner_member_id = p_member_id THEN 'win'
            WHEN matchup.winner_member_id IS NOT NULL THEN 'loss'
            WHEN matchup.my_points > matchup.opponent_points THEN 'win'
            WHEN matchup.my_points < matchup.opponent_points THEN 'loss' ELSE 'tie' END
        WHEN matchup.id IS NULL AND week.week_number >= settings.playoff_start THEN 'playoffs'
        WHEN (settings.value->>'today')::date BETWEEN week.week_start AND week.week_end AND matchup.id IS NOT NULL THEN 'live'
        WHEN week.week_end < (settings.value->>'today')::date THEN 'pending'
        ELSE 'upcoming' END AS status,
      CASE WHEN matchup.is_finalized OR (settings.value->>'today')::date BETWEEN week.week_start AND week.week_end
        THEN matchup.my_points END AS my_points,
      CASE WHEN matchup.is_finalized OR (settings.value->>'today')::date BETWEEN week.week_start AND week.week_end
        THEN matchup.opponent_points END AS opponent_points
    FROM public.season_weeks week CROSS JOIN settings
    LEFT JOIN matchups matchup ON week.week_number BETWEEN matchup.week_number AND matchup.end_week
      AND NOT (settings.skipped_weeks @> jsonb_build_array(week.week_number))
    LEFT JOIN public.league_members member ON member.id = matchup.opponent_id
    WHERE week.season_year = (settings.value->>'seasonYear')::integer
      AND week.week_number < settings.playoff_start + settings.playoff_weeks
    ORDER BY week.week_number, matchup.week_number DESC, matchup.id
  )
  SELECT jsonb_build_object('context', jsonb_build_object(
      'leagueId', value->'leagueId', 'memberId', value->'memberId', 'seasonId', value->'seasonId',
      'seasonYear', value->'seasonYear', 'weekNumber', value->'weekNumber', 'today', value->'today',
      'pendingIncomingCount', value->'pendingIncomingCount', 'version', (SELECT version::text FROM public.league_versions WHERE league_id = p_league_id), 'stale', false, 'league', jsonb_build_object('timezone', value->'league'->'timezone')),
    'schedule', COALESCE((SELECT jsonb_agg(jsonb_build_object('weekNumber', week_number,
      'opponentTeamName', team_name, 'isCurrent', is_current, 'status', status,
      'myPoints', my_points, 'opponentPoints', opponent_points) ORDER BY week_number) FROM weeks), '[]'::jsonb))
  FROM context;
$$;
