CREATE OR REPLACE FUNCTION public.stats_window(p_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE last_date date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF p_days IS NULL THEN RETURN NULL; END IF;
  IF p_days NOT IN (7, 15) THEN
    RAISE EXCEPTION 'Choose past 7 or 15 days.' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('days', p_days, 'startDate', last_date - (p_days - 1),
    'endDate', last_date, 'timeZone', 'America/New_York');
END;
$$;

CREATE OR REPLACE FUNCTION public.player_window_averages(p_league_id uuid, p_days integer, p_player_ids uuid[] DEFAULT NULL)
RETURNS TABLE(player_id uuid, season_year integer, avg_fantasy_points numeric,
  avg_points numeric, avg_rebounds numeric, avg_assists numeric, avg_steals numeric,
  avg_blocks numeric, avg_turnovers numeric, avg_three_pointers_made numeric,
  avg_minutes_played numeric, games_played integer)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH selected_window AS MATERIALIZED (SELECT public.stats_window(p_days) AS dates)
  SELECT s.player_id, public.current_season_year_et(), round(avg(fp.fantasy_points), 2),
    round(avg(s.points), 1), round(avg(s.rebounds), 1), round(avg(s.assists), 1),
    round(avg(s.steals), 2), round(avg(s.blocks), 2), round(avg(s.turnovers), 2),
    round(avg(s.three_pointers_made), 2), round(avg(s.minutes_played), 1), count(*)::integer
  FROM selected_window
  JOIN public.nba_games g ON g.game_date BETWEEN (dates->>'startDate')::date AND (dates->>'endDate')::date
    AND public.is_regular_season_game_id(g.nba_game_id)
  JOIN public.player_game_stats s ON s.game_id = g.id AND NOT s.did_not_play
  LEFT JOIN public.v_fantasy_points fp ON fp.stat_id = s.id AND fp.league_id = p_league_id
  WHERE p_days IS NOT NULL AND (p_player_ids IS NULL OR s.player_id = ANY(p_player_ids))
  GROUP BY s.player_id;
$$;

DROP FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer);

CREATE OR REPLACE FUNCTION public.view_player_search(
  p_query text DEFAULT '',
  p_position text DEFAULT 'ALL',
  p_teams text[] DEFAULT '{}',
  p_league_id uuid DEFAULT NULL,
  p_playing_teams text[] DEFAULT NULL,
  p_excluded_teams text[] DEFAULT '{}',
  p_include_player_ids uuid[] DEFAULT NULL,
  p_exclude_player_ids uuid[] DEFAULT '{}',
  p_rookies_only boolean DEFAULT false,
  p_health text DEFAULT 'all',
  p_sort_by text DEFAULT 'fpts',
  p_sort_dir text DEFAULT 'desc',
  p_season_year int DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0,
  p_stats_days int DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  status text,
  injury_status text,
  headshot_url text,
  nba_id text,
  years_exp int,
  avg_fantasy_points numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_turnovers numeric,
  avg_three_pointers_made numeric,
  avg_minutes_played numeric,
  games_played int,
  projection_fantasy_points numeric,
  projection_source text,
  projection_source_label text,
  projection_view text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_opponent text,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_status text,
  stats_season_year int,
  career_regular_season_games int,
  birthdate date,
  age int,
  injury_reason text,
  injury_expected_return text
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  v_stats_season int;
  v_current_season int := public.current_season_year_et();
BEGIN
PERFORM public.stats_window(p_stats_days);
v_stats_season := COALESCE(CASE WHEN p_stats_days IS NOT NULL THEN v_current_season ELSE p_season_year END, CASE WHEN EXISTS (
  SELECT 1
  FROM public.nba_games g
  WHERE g.season_year = v_current_season
    AND public.is_regular_season_game_id(g.nba_game_id)
    AND (g.status = 'Final' OR EXISTS (
      SELECT 1 FROM public.player_game_stats s
      WHERE s.game_id = g.id
        AND NOT s.did_not_play
        AND (s.minutes_played > 0 OR s.points > 0 OR s.rebounds > 0
          OR s.assists > 0 OR s.steals > 0 OR s.blocks > 0
          OR s.turnovers > 0 OR s.field_goals_attempted > 0
          OR s.free_throws_attempted > 0)
    ))
) THEN v_current_season ELSE v_current_season - 1 END);
RETURN QUERY
WITH args AS (
  SELECT
    NULLIF(trim(COALESCE(p_query, '')), '') AS query_text,
    CASE COALESCE(p_position, 'ALL')
      WHEN 'ALL' THEN ARRAY[]::text[]
      WHEN 'G' THEN ARRAY['PG', 'SG']::text[]
      WHEN 'F' THEN ARRAY['SF', 'PF']::text[]
      ELSE ARRAY[p_position]::text[]
    END AS pos_filter,
    CASE
      WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN
          ARRAY(
            SELECT explicit_team
            FROM unnest(COALESCE(p_teams, '{}')) AS explicit_team
            WHERE explicit_team = ANY(COALESCE(p_playing_teams, '{}'))
            ORDER BY explicit_team
          )
      WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')
      ELSE COALESCE(p_teams, '{}')
    END AS effective_teams,
    (p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active,
    COALESCE(p_excluded_teams, '{}') AS excluded_teams,
    COALESCE(p_exclude_player_ids, '{}') AS exclude_player_ids,
    LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
current_averages AS MATERIALIZED (
  SELECT * FROM public.player_window_averages(p_league_id, p_stats_days, p_include_player_ids)
  WHERE p_stats_days IS NOT NULL
  UNION ALL
  SELECT cached.player_id, cached.season_year, cached.avg_fantasy_points,
    (cached.averages->>'avg_points')::numeric AS avg_points,
    (cached.averages->>'avg_rebounds')::numeric AS avg_rebounds,
    (cached.averages->>'avg_assists')::numeric AS avg_assists,
    (cached.averages->>'avg_steals')::numeric AS avg_steals,
    (cached.averages->>'avg_blocks')::numeric AS avg_blocks,
    (cached.averages->>'avg_turnovers')::numeric AS avg_turnovers,
    (cached.averages->>'avg_three_pointers_made')::numeric AS avg_three_pointers_made,
    (cached.averages->>'avg_minutes_played')::numeric AS avg_minutes_played,
    (cached.averages->>'games_played')::integer AS games_played
  FROM public.player_season_averages cached
  WHERE p_stats_days IS NULL AND cached.league_id = p_league_id AND cached.season_year = v_stats_season
    AND v_stats_season = v_current_season AND cached.averages IS NOT NULL
    AND (p_include_player_ids IS NULL OR cached.player_id = ANY(p_include_player_ids))
),
season_averages AS (
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM current_averages
  UNION ALL
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM public.mv_player_season_averages
  WHERE p_stats_days IS NULL AND season_year = v_stats_season AND v_stats_season <> v_current_season
),
league_scores AS MATERIALIZED (
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE p_stats_days IS NULL AND fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND (p_include_player_ids IS NULL OR fp.player_id = ANY(p_include_player_ids))
),
score_source AS (
  SELECT player_id, avg_fantasy_points FROM current_averages
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE p_stats_days IS NULL AND fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND NOT COALESCE(p_health IN ('healthy', 'gtd', 'out', 'ir'), false)
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM league_scores AS fp
  WHERE p_health IN ('healthy', 'gtd', 'out', 'ir')
),
filtered_base AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.status,
    p.injury_status,
    p.headshot_url,
    p.nba_id,
    p.years_exp,
    p.dynasty_rank,
    p.career_regular_season_games,
    p.birthdate,
    p.injury_reason,
    p.injury_expected_return,
    fp.avg_fantasy_points,
    avg.avg_points,
    avg.avg_rebounds,
    avg.avg_assists,
    avg.avg_steals,
    avg.avg_blocks,
    avg.avg_turnovers,
    avg.avg_three_pointers_made,
    avg.avg_minutes_played,
    CASE WHEN p_stats_days IS NOT NULL THEN COALESCE(avg.games_played, 0) ELSE avg.games_played END::int AS games_played
  FROM args
  JOIN public.players AS p ON true
  LEFT JOIN season_averages AS avg
    ON avg.player_id = p.id
   AND avg.season_year = v_stats_season
  LEFT JOIN score_source AS fp
    ON fp.player_id = p.id
  WHERE
    (args.query_text IS NULL OR p.display_name ILIKE ('%' || args.query_text || '%'))
    AND (cardinality(args.pos_filter) = 0 OR EXISTS (
      SELECT 1
      FROM unnest(p.eligible_positions) AS player_position
      WHERE player_position::text = ANY(args.pos_filter)
    ))
    AND (NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))
    AND (cardinality(args.excluded_teams) = 0 OR p.nba_team IS NULL OR p.nba_team <> ALL(args.excluded_teams))
    AND (p_include_player_ids IS NULL OR p.id = ANY(p_include_player_ids))
    AND (cardinality(args.exclude_player_ids) = 0 OR p.id <> ALL(args.exclude_player_ids))
    AND (NOT p_rookies_only OR p.years_exp = 0)
    AND CASE COALESCE(p_health, 'all')
      WHEN 'healthy' THEN p.injury_status IS NULL
      WHEN 'gtd' THEN p.injury_status = ANY(ARRAY['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
      WHEN 'out' THEN p.injury_status = ANY(ARRAY['Out', 'OUT', 'O'])
      WHEN 'ir' THEN p.injury_status = ANY(ARRAY['IR', 'IR-LTI'])
      ELSE true
    END
),
paged_base AS (
  SELECT *
  FROM (
    SELECT
      filtered_base.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN p_sort_by = 'dynasty' THEN filtered_base.dynasty_rank END ASC NULLS LAST,
          CASE WHEN p_sort_by = 'dynasty' AND filtered_base.dynasty_rank IS NULL THEN filtered_base.avg_fantasy_points END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN filtered_base.avg_fantasy_points END ASC NULLS LAST,
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN filtered_base.avg_fantasy_points END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END ASC,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END DESC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_points, 0) END ASC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_points, 0) END DESC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END ASC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END DESC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END ASC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END DESC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END ASC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END DESC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END ASC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END DESC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END ASC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END DESC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END ASC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END DESC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.games_played, 0) END ASC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.games_played, 0) END DESC,
          filtered_base.display_name ASC,
          filtered_base.id ASC
      ) AS page_rank
    FROM filtered_base
  ) ranked_base
  ORDER BY page_rank
  LIMIT (SELECT page_limit FROM args)
  OFFSET (SELECT page_offset FROM args)
),
projection AS (
  SELECT *
  FROM public.get_league_projection_rows(
    p_league_id,
    v_stats_season,
    (timezone('America/New_York', now()))::date,
    'today',
    COALESCE((SELECT array_agg(paged_base.id ORDER BY paged_base.id) FROM paged_base), ARRAY[]::uuid[]),
    (SELECT page_limit FROM args),
    0
  )
  WHERE p_league_id IS NOT NULL
)
SELECT
  pb.id,
  pb.display_name,
  pb.nba_team,
  pb."position",
  pb.eligible_positions,
  pb.status,
  pb.injury_status,
  pb.headshot_url,
  pb.nba_id,
  pb.years_exp,
  pb.avg_fantasy_points,
  pb.avg_points,
  pb.avg_rebounds,
  pb.avg_assists,
  pb.avg_steals,
  pb.avg_blocks,
  pb.avg_turnovers,
  pb.avg_three_pointers_made,
  pb.avg_minutes_played,
  pb.games_played,
  proj.projection_fantasy_points,
  proj.projection_source,
  proj.projection_source_label,
  proj.projection_view,
  proj.projection_fetched_at,
  proj.projection_date,
  proj.next_game_opponent AS projection_opponent,
  proj.projection_minutes,
  proj.projection_points,
  proj.projection_rebounds,
  proj.projection_assists,
  proj.projection_steals,
  proj.projection_blocks,
  proj.projection_three_pointers_made,
  proj.projection_turnovers,
  proj.projection_status,
  v_stats_season,
  pb.career_regular_season_games,
  pb.birthdate,
  extract(year FROM age((now() AT TIME ZONE 'America/Los_Angeles')::date,pb.birthdate))::int,
  pb.injury_reason,
  pb.injury_expected_return
FROM paged_base pb
LEFT JOIN projection AS proj
  ON proj.player_id = pb.id
ORDER BY pb.page_rank;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_players(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE context jsonb; players jsonb; ownership jsonb; waivers jsonb; pending jsonb; transaction_state jsonb;
  include_ids uuid[]; exclude_ids uuid[]; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 20), 1), 50);
BEGIN
  IF p_params->>'availability' = 'mine' THEN p_params := p_params - 'statsDays'; END IF;
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT COALESCE(jsonb_object_agg(r.player_id::text, jsonb_build_object('teamName', COALESCE(m.team_name, 'Team'),
    'memberId', r.member_id, 'isOnIR', r.is_on_ir, 'isOnTaxi', r.is_on_taxi)), '{}') INTO ownership
    FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id
    WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid;
  SELECT COALESCE(jsonb_object_agg(player_id::text, clears_at), '{}') INTO waivers FROM (
    SELECT player_id, max(clears_at) AS clears_at FROM public.waiver_wire_log WHERE league_id = p_league_id
      AND league_season_id = (context->>'seasonId')::uuid AND cleared_at IS NULL AND clears_at > now()
      AND (context->'season'->>'is_current')::boolean GROUP BY player_id) logs;
  SELECT COALESCE(jsonb_agg(DISTINCT player_id), '[]') INTO pending FROM public.waiver_claims
    WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid
      AND status = 'pending' AND (context->'season'->>'is_current')::boolean;
  IF p_params ? 'includePlayerIds' THEN SELECT array_agg(value::uuid) INTO include_ids FROM jsonb_array_elements_text(p_params->'includePlayerIds'); END IF;
  IF p_params->>'availability' = 'rostered' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(ownership);
  ELSIF p_params->>'availability' = 'mine' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(ownership) WHERE value->>'memberId' = p_member_id::text;
  ELSIF p_params->>'availability' = 'waivers' THEN SELECT COALESCE(array_agg(key::uuid), '{}') INTO include_ids FROM jsonb_each(waivers);
  END IF;
  SELECT COALESCE(array_agg(value::uuid), '{}') INTO exclude_ids FROM jsonb_array_elements_text(COALESCE(p_params->'excludePlayerIds', '[]'));
  IF p_params->>'availability' IN ('available', 'free_agents') THEN
    exclude_ids := exclude_ids || ARRAY(SELECT key::uuid FROM jsonb_each(ownership));
    IF p_params->>'availability' = 'free_agents' THEN exclude_ids := exclude_ids || ARRAY(SELECT key::uuid FROM jsonb_each(waivers)); END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM public.players WHERE id = player.id))), '[]') INTO players FROM public.view_player_search(
    p_query := COALESCE(p_params->>'query', ''), p_position := COALESCE(p_params->>'position', 'ALL'),
    p_teams := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_params->'teams', '[]'))), p_league_id := p_league_id,
    p_playing_teams := CASE WHEN p_params->>'playing' = 'today' THEN ARRAY(SELECT home_team FROM public.nba_games WHERE game_date = (context->>'today')::date UNION SELECT away_team FROM public.nba_games WHERE game_date = (context->>'today')::date) WHEN p_params ? 'playingTeams' THEN ARRAY(SELECT jsonb_array_elements_text(p_params->'playingTeams')) END,
    p_excluded_teams := CASE WHEN p_params->>'playing' = 'not_today' THEN ARRAY(SELECT home_team FROM public.nba_games WHERE game_date = (context->>'today')::date UNION SELECT away_team FROM public.nba_games WHERE game_date = (context->>'today')::date) ELSE ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_params->'excludedTeams', '[]'))) END,
    p_include_player_ids := include_ids, p_exclude_player_ids := exclude_ids,
    p_rookies_only := COALESCE((p_params->>'rookiesOnly')::boolean, false), p_health := COALESCE(p_params->>'health', 'all'),
    p_sort_by := COALESCE(p_params->>'sortBy', 'fpts'), p_sort_dir := COALESCE(p_params->>'sortDir', 'desc'),
    p_season_year := (p_params->>'seasonYear')::integer, p_limit := page_size,
    p_stats_days := (p_params->>'statsDays')::integer,
    p_offset := GREATEST(COALESCE((p_params->>'offset')::integer, 0), 0)) player;
  transaction_state := public.view_transaction_state(p_league_id, p_member_id, p_params);
  RETURN jsonb_build_object('context', context, 'players', players, 'ownedMap',
    CASE WHEN p_params->>'availability'='free_agents' AND NOT (p_params ? 'includePlayerIds') THEN '{}'::jsonb ELSE ownership END,
    'waiverClearsAt', waivers,
    'waiverIds', COALESCE((SELECT jsonb_agg(key) FROM jsonb_each(waivers)), '[]'), 'pendingClaimIds', pending,
    'transactionState', transaction_state, 'claims', public.view_claims(p_league_id, p_member_id, p_params)->'claims',
    'hasMore', jsonb_array_length(players) = page_size, 'weekDays', public.view_lineup(p_league_id, p_member_id, p_params)->'weekDays',
    'visibleTotals', CASE WHEN p_params->>'statsDays' IS NOT NULL THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(to_jsonb(totals)) FROM public.get_visible_player_totals(p_league_id,
      ARRAY(SELECT (player->>'id')::uuid FROM jsonb_array_elements(players) player),
      COALESCE((p_params->>'seasonYear')::integer, (players->0->>'stats_season_year')::integer, (context->>'seasonYear')::integer)) totals), '[]') END)
    || CASE WHEN p_params->>'statsDays' IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('statsWindow', public.stats_window((p_params->>'statsDays')::integer)) END;
END;
$$;

REVOKE ALL ON FUNCTION public.stats_window(integer), public.player_window_averages(uuid,integer,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stats_window(integer), public.player_window_averages(uuid,integer,uuid[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer,integer) TO authenticated, service_role;
