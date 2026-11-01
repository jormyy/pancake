-- Canonical SQL source for private.matchup_forecast_input_fingerprint.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.matchup_forecast_input_fingerprint(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,m.home_points,m.away_points,m.is_finalized,
    s.season_year,m.week_number,COALESCE(m.end_week_number,m.week_number) AS end_week_number,w.week_start,e.week_end,l.scoring_settings,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m JOIN public.leagues l ON l.id=m.league_id
  JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided
), roster AS MATERIALIZED (
  SELECT r.member_id,r.player_id,r.is_on_ir,r.is_on_taxi,p.nba_team,p.eligible_positions,p.injury_status
  FROM context c JOIN public.roster_players r ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id
    AND r.member_id IN(c.home_member_id,c.away_member_id)
  JOIN public.players p ON p.id=r.player_id
), games AS MATERIALIZED (
  SELECT g.id,g.game_date,g.home_team,g.away_team,g.status,g.game_time,g.started_at,
    g.live_scoreboard_elapsed_seconds,g.live_stats_elapsed_seconds
  FROM context c JOIN public.nba_games g ON g.season_year=c.season_year
    AND g.game_date BETWEEN c.week_start AND c.week_end
  WHERE public.is_regular_season_game_id(g.nba_game_id)
), freshness AS MATERIALIZED (
  SELECT 'sleeper' AS source,r.id::text AS id,r.fetched_at+interval '36 hours' AS expires
  FROM context c JOIN public.sleeper_projection_rows r ON r.season_year=c.season_year
    AND r.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  WHERE r.player_id IN(SELECT player_id FROM roster)
  UNION ALL
  SELECT 'fantasypros',r.id::text,r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END
  FROM context c JOIN public.fantasypros_projection_rows r
    ON r.projection_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
      OR r.season_year=c.season_year AND r.projection_type<>'daily'
        AND (r.week_number IS NULL OR r.week_number BETWEEN c.week_number AND c.end_week_number)
  JOIN public.projection_sync_runs run ON run.id=r.run_id AND run.source='fantasypros'
    AND run.status='success' AND run.completed_at IS NOT NULL
  WHERE r.match_status='matched' AND r.player_id IN(SELECT player_id FROM roster)
)
SELECT jsonb_build_object(
  'inputs',md5(jsonb_build_object(
    'context',to_jsonb(c),
    'revisions',(SELECT jsonb_object_agg(kind,revision) FROM private.forecast_input_revisions WHERE kind IN('source','history')),
    'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id) FROM roster r),
    'games',(SELECT jsonb_agg(jsonb_build_array(g.id,g.game_date,g.home_team,g.away_team,g.status,g.game_time,g.started_at,
      COALESCE(g.game_time<=now(),false) OR COALESCE(g.started_at<=now(),false)) ORDER BY g.game_date,g.id) FROM games g),
    'stats',(SELECT jsonb_agg(to_jsonb(s)-ARRAY['updated_at','created_at','fetched_at'] ORDER BY s.game_id,s.player_id)
      FROM public.player_game_stats s JOIN games g ON g.id=s.game_id WHERE s.player_id IN(SELECT player_id FROM roster)),
    'lineups',(SELECT jsonb_agg(jsonb_build_array(l.member_id,l.player_id,l.game_date,l.slot_type,l.is_auto_set)
      ORDER BY l.game_date,l.member_id,l.player_id) FROM public.weekly_lineups l
      WHERE l.league_season_id=c.league_season_id AND l.member_id IN(c.home_member_id,c.away_member_id)
        AND l.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end),
    'templates',(SELECT jsonb_agg(jsonb_build_array(t.slot_type,t.slot_count) ORDER BY t.slot_type)
      FROM public.lineup_slot_templates t WHERE t.league_id=c.league_id AND t.slot_type NOT IN('BE','IR')),
    'automaticMembers',(SELECT jsonb_agg(s.member_id ORDER BY s.member_id) FROM public.lineup_optimizer_settings s
      WHERE s.league_season_id=c.league_season_id AND s.member_id IN(c.home_member_id,c.away_member_id) AND s.enabled),
    'freshness',(SELECT jsonb_agg(jsonb_build_array(f.source,f.id,f.expires>=now()) ORDER BY f.source,f.id) FROM freshness f)
  )::text),
  'clock',md5(COALESCE((SELECT jsonb_agg(jsonb_build_array(g.id,g.live_scoreboard_elapsed_seconds,g.live_stats_elapsed_seconds)
    ORDER BY g.id) FROM games g WHERE g.status='InProgress'
      AND EXISTS(SELECT 1 FROM roster r WHERE r.nba_team IN(g.home_team,g.away_team)))::text,'')),
  'validUntil',LEAST(now()+interval '30 minutes',(c.today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM games g WHERE g.game_time>now()),
    (SELECT min(g.started_at) FROM games g WHERE g.started_at>now()),
    (SELECT min(f.expires) FROM freshness f WHERE f.expires>=now()))
) FROM context c;
$$;
