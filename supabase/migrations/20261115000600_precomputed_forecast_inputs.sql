CREATE TABLE private.forecast_input_revisions(kind text PRIMARY KEY CHECK(kind IN ('history','projection')),revision bigint NOT NULL DEFAULT 1);
INSERT INTO private.forecast_input_revisions(kind) VALUES('history'),('projection');
CREATE TABLE private.forecast_player_history(
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  season_year integer NOT NULL,player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  observed_date date NOT NULL,revision bigint NOT NULL,scoring_hash text NOT NULL,scores numeric[],
  PRIMARY KEY(league_id,season_year,player_id)
);
CREATE TABLE private.forecast_projection_inputs(
  matchup_id uuid NOT NULL REFERENCES public.matchups(id) ON DELETE CASCADE,game_date date NOT NULL,
  observed_date date NOT NULL,revision bigint NOT NULL,scoring_hash text NOT NULL,roster_hash text NOT NULL,
  valid_until timestamptz NOT NULL,rows jsonb NOT NULL,PRIMARY KEY(matchup_id,game_date)
);
REVOKE ALL ON private.forecast_input_revisions,private.forecast_player_history,private.forecast_projection_inputs FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS weekly_lineups_forecast_date_idx
  ON public.weekly_lineups(league_season_id,member_id,game_date,player_id) INCLUDE(slot_type,is_auto_set);

CREATE TABLE private.forecast_season_points(
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,season_year integer NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,scoring_hash text NOT NULL,source_revision text NOT NULL,fantasy_points numeric,
  PRIMARY KEY(league_id,season_year,player_id)
);
REVOKE ALL ON private.forecast_season_points FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX forecast_season_points_player_idx ON private.forecast_season_points(player_id,season_year);
CREATE OR REPLACE FUNCTION private.compute_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.*,s.season_year,w.week_start,e.week_end,l.scoring_settings,now() AS observed_at,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m
  JOIN public.leagues l ON l.id=m.league_id
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
    AND g.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  WHERE public.is_regular_season_game_id(g.nba_game_id)
), history AS (
  SELECT r.player_id,array_agg(public.projection_stat_fantasy_points(
    h.points,h.rebounds,h.assists,h.steals,h.blocks,h.three_pointers_made,h.turnovers,
    h.field_goals_made,h.field_goals_attempted,h.free_throws_made,h.free_throws_attempted,
    CASE WHEN h.double_double THEN 1 ELSE 0 END,CASE WHEN h.triple_double THEN 1 ELSE 0 END,
    c.scoring_settings) ORDER BY h.game_date,h.id) AS scores
  FROM context c CROSS JOIN roster r
  CROSS JOIN LATERAL (
    SELECT pgs.* FROM public.player_game_stats pgs
    JOIN public.nba_games g ON g.id=pgs.game_id
    WHERE pgs.player_id=r.player_id AND NOT pgs.did_not_play AND g.status='Final'
      AND pgs.game_date<c.today AND pgs.season_year BETWEEN c.season_year-1 AND c.season_year
      AND public.is_regular_season_game_id(g.nba_game_id)
    ORDER BY pgs.game_date DESC,pgs.id LIMIT 30
  ) h GROUP BY r.player_id
), projections AS (
  SELECT d.game_date AS requested_date,p.player_id,p.projection_fantasy_points,p.projection_source_label,
    p.projection_fetched_at,p.projection_date,p.projection_is_fresh
  FROM context c CROSS JOIN (SELECT DISTINCT game_date FROM games WHERE status NOT IN('Final','Postponed','Cancelled')) d
  CROSS JOIN LATERAL public.get_league_projection_rows(c.league_id,c.season_year,d.game_date,'today',
    ARRAY(SELECT player_id FROM roster),100,0) p
)
SELECT jsonb_build_object(
  'matchupId',c.id,'observedAt',c.observed_at,'today',c.today,'weekEnd',c.week_end,'isFinalized',c.is_finalized,
  'teams',jsonb_build_array(jsonb_build_object('memberId',c.home_member_id,'currentPoints',COALESCE(c.home_points,0)),
    jsonb_build_object('memberId',c.away_member_id,'currentPoints',COALESCE(c.away_points,0))),
  'roster',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id) FROM roster r),'[]'::jsonb),
  'games',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.game_date,g.id) FROM games g),'[]'::jsonb),
  'history',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.player_id) FROM history h),'[]'::jsonb),
  'projections',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.requested_date,p.player_id) FROM projections p),'[]'::jsonb),
  'lineups',COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id',l.member_id,'player_id',l.player_id,
    'game_date',l.game_date,'slot_type',l.slot_type,'is_auto_set',l.is_auto_set) ORDER BY l.game_date,l.member_id,l.player_id)
    FROM public.weekly_lineups l WHERE l.league_season_id=c.league_season_id
      AND l.member_id IN(c.home_member_id,c.away_member_id) AND l.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end),'[]'::jsonb),
  'templates',COALESCE((SELECT jsonb_agg(jsonb_build_object('slot_type',t.slot_type,'slot_count',t.slot_count) ORDER BY t.slot_type)
    FROM public.lineup_slot_templates t WHERE t.league_id=c.league_id AND t.slot_type NOT IN('BE','IR')),'[]'::jsonb),
  'automaticMembers',COALESCE((SELECT jsonb_agg(s.member_id ORDER BY s.member_id)
    FROM public.lineup_optimizer_settings s WHERE s.league_season_id=c.league_season_id
      AND s.member_id IN(c.home_member_id,c.away_member_id) AND s.enabled),'[]'::jsonb),
  'previous',COALESCE((SELECT f.forecast FROM public.matchup_forecasts f WHERE f.matchup_id=c.id),'null'::jsonb)
) FROM context c;
$$;

CREATE OR REPLACE FUNCTION private.matchup_forecast_inputs_ready(p_matchup_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,s.season_year,
    w.week_start,e.week_end,md5(l.scoring_settings::text) AS scoring_hash,
    (now() AT TIME ZONE 'America/New_York')::date AS today,
    (SELECT revision FROM private.forecast_input_revisions WHERE kind='history') AS history_revision,
    (SELECT revision FROM private.forecast_input_revisions WHERE kind='projection') AS projection_revision
  FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.leagues l ON l.id=m.league_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided
), players AS MATERIALIZED (
  SELECT r.player_id FROM context c JOIN public.roster_players r
    ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id
    AND r.member_id IN(c.home_member_id,c.away_member_id)
), roster AS (
  SELECT md5(COALESCE(string_agg(player_id::text,',' ORDER BY player_id),'')) AS fingerprint FROM players
)
SELECT EXISTS(SELECT 1 FROM context) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN players r LEFT JOIN private.forecast_player_history h
    ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
  WHERE h.player_id IS NULL OR h.observed_date<>c.today OR h.revision<>c.history_revision OR h.scoring_hash<>c.scoring_hash
) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN players r JOIN analytics.player_season_totals t
    ON t.player_id=r.player_id AND t.season_year=c.season_year
  LEFT JOIN private.forecast_season_points p ON p.league_id=c.league_id AND p.season_year=c.season_year AND p.player_id=r.player_id
  WHERE p.player_id IS NULL OR p.scoring_hash<>c.scoring_hash OR p.source_revision<>t.xmin::text
) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN roster r JOIN public.nba_games g ON g.season_year=c.season_year
    AND g.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  LEFT JOIN private.forecast_projection_inputs p ON p.matchup_id=c.id AND p.game_date=g.game_date
  WHERE public.is_regular_season_game_id(g.nba_game_id) AND g.status NOT IN('Final','Postponed','Cancelled')
    AND (p.matchup_id IS NULL OR p.observed_date<>c.today OR p.revision<>c.projection_revision
      OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>r.fingerprint OR p.valid_until<=now())
);
$$;

CREATE OR REPLACE FUNCTION private.invalidate_forecast_inputs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_history boolean:=false; v_projection boolean:=false;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    v_history:=TG_TABLE_NAME IN('player_game_stats','nba_games');
    v_projection:=TG_TABLE_NAME<>'player_game_stats';
  ELSIF TG_TABLE_NAME='player_game_stats' THEN
    IF TG_OP<>'DELETE' THEN SELECT EXISTS(SELECT 1 FROM forecast_new WHERE game_date<v_today) INTO v_history; END IF;
    IF TG_OP<>'INSERT' AND NOT v_history THEN SELECT EXISTS(SELECT 1 FROM forecast_old WHERE game_date<v_today) INTO v_history; END IF;
  ELSIF TG_TABLE_NAME='nba_games' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date<v_today OR n.game_date<v_today)
        AND (o.game_date,o.season_year,o.status,o.nba_game_id) IS DISTINCT FROM (n.game_date,n.season_year,n.status,n.nba_game_id))
      INTO v_history;
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date,o.season_year,o.status,o.nba_game_id,o.home_team,o.away_team,o.game_time,o.started_at)
        IS DISTINCT FROM (n.game_date,n.season_year,n.status,n.nba_game_id,n.home_team,n.away_team,n.game_time,n.started_at))
      INTO v_projection;
  ELSIF TG_TABLE_NAME='players' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.nba_team,o.first_name,o.last_name,o.display_name)
        IS DISTINCT FROM (n.nba_team,n.first_name,n.last_name,n.display_name)) INTO v_projection;
  ELSIF TG_TABLE_NAME='leagues' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE o.scoring_settings IS DISTINCT FROM n.scoring_settings) INTO v_projection;
  ELSE
    IF TG_OP<>'DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_new WHERE game_date<v_today) INTO v_history; END IF;
    ELSE
      SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_old WHERE game_date<v_today) INTO v_history; END IF;
    END IF;
  END IF;
  UPDATE private.forecast_input_revisions SET revision=revision+1
    WHERE kind='history' AND v_history OR kind='projection' AND v_projection;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.update_forecast_season_points()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    DELETE FROM private.forecast_season_points;
  ELSIF TG_OP='DELETE' THEN
    DELETE FROM private.forecast_season_points p USING forecast_old o
      WHERE p.player_id=o.player_id AND p.season_year=o.season_year;
  ELSE
    UPDATE private.forecast_season_points p SET scoring_hash=md5(l.scoring_settings::text),source_revision=t.xmin::text,
      fantasy_points=public.projection_stat_fantasy_points(a.avg_points,a.avg_rebounds,a.avg_assists,a.avg_steals,a.avg_blocks,
        a.avg_three_pointers_made,a.avg_turnovers,a.avg_field_goals_made,a.avg_field_goals_attempted,
        a.avg_free_throws_made,a.avg_free_throws_attempted,
        CASE WHEN a.games_played>0 THEN a.double_doubles::numeric/a.games_played ELSE 0 END,
        CASE WHEN a.games_played>0 THEN a.triple_doubles::numeric/a.games_played ELSE 0 END,l.scoring_settings)
    FROM public.mv_player_season_averages a JOIN forecast_new n USING(player_id,season_year)
      JOIN analytics.player_season_totals t USING(player_id,season_year),public.leagues l
    WHERE p.player_id=a.player_id AND p.season_year=a.season_year AND l.id=p.league_id;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection';
  ELSIF TG_OP='INSERT' THEN
    IF EXISTS(SELECT 1 FROM forecast_new) THEN UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection'; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM forecast_old) THEN UPDATE private.forecast_input_revisions SET revision=revision+1 WHERE kind='projection'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_matchup_forecast_inputs(p_matchup_id uuid,p_game_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record; v_ids uuid[]; v_missing uuid[]; v_roster_hash text; v_history_revision bigint;
  v_projection_revision bigint; v_dates date[]; v_rows jsonb; v_expires timestamptz;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  SELECT m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,s.season_year,
    w.week_start,e.week_end,l.scoring_settings,md5(l.scoring_settings::text) AS scoring_hash INTO c
  FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.leagues l ON l.id=m.league_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(array_agg(player_id ORDER BY player_id),'{}'::uuid[]),
    md5(COALESCE(string_agg(player_id::text,',' ORDER BY player_id),'')) INTO v_ids,v_roster_hash
  FROM public.roster_players WHERE league_id=c.league_id AND league_season_id=c.league_season_id
    AND member_id IN(c.home_member_id,c.away_member_id);
  SELECT revision INTO STRICT v_history_revision FROM private.forecast_input_revisions WHERE kind='history';
  SELECT revision INTO STRICT v_projection_revision FROM private.forecast_input_revisions WHERE kind='projection';
  SELECT COALESCE(array_agg(DISTINCT g.game_date ORDER BY g.game_date),'{}'::date[]) INTO v_dates
  FROM public.nba_games g WHERE g.season_year=c.season_year
    AND g.game_date BETWEEN GREATEST(c.week_start,v_today) AND c.week_end
    AND public.is_regular_season_game_id(g.nba_game_id) AND g.status NOT IN('Final','Postponed','Cancelled');
  IF p_game_date IS NULL THEN
    INSERT INTO private.forecast_season_points AS stored(league_id,season_year,player_id,scoring_hash,source_revision,fantasy_points)
    SELECT c.league_id,c.season_year,a.player_id,c.scoring_hash,t.xmin::text,
      public.projection_stat_fantasy_points(a.avg_points,a.avg_rebounds,a.avg_assists,a.avg_steals,a.avg_blocks,
        a.avg_three_pointers_made,a.avg_turnovers,a.avg_field_goals_made,a.avg_field_goals_attempted,
        a.avg_free_throws_made,a.avg_free_throws_attempted,
        CASE WHEN a.games_played>0 THEN a.double_doubles::numeric/a.games_played ELSE 0 END,
        CASE WHEN a.games_played>0 THEN a.triple_doubles::numeric/a.games_played ELSE 0 END,c.scoring_settings)
    FROM public.mv_player_season_averages a JOIN analytics.player_season_totals t USING(player_id,season_year)
    LEFT JOIN private.forecast_season_points existing ON existing.league_id=c.league_id
      AND existing.season_year=a.season_year AND existing.player_id=a.player_id
    WHERE a.player_id=ANY(v_ids) AND a.season_year=c.season_year
      AND (existing.player_id IS NULL OR existing.scoring_hash IS DISTINCT FROM c.scoring_hash OR existing.source_revision IS DISTINCT FROM t.xmin::text)
    ORDER BY a.player_id
    ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET scoring_hash=EXCLUDED.scoring_hash,
      source_revision=EXCLUDED.source_revision,fantasy_points=EXCLUDED.fantasy_points;
    SELECT array_agg(r.player_id) INTO v_missing FROM unnest(v_ids) r(player_id)
    LEFT JOIN private.forecast_player_history h ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
    WHERE h.player_id IS NULL OR h.observed_date<>v_today OR h.revision<>v_history_revision OR h.scoring_hash<>c.scoring_hash;
    IF cardinality(v_missing)>0 THEN
      INSERT INTO private.forecast_player_history(league_id,season_year,player_id,observed_date,revision,scoring_hash,scores)
      SELECT c.league_id,c.season_year,r.player_id,v_today,v_history_revision,c.scoring_hash,
        (SELECT array_agg(public.projection_stat_fantasy_points(h.points,h.rebounds,h.assists,h.steals,h.blocks,
          h.three_pointers_made,h.turnovers,h.field_goals_made,h.field_goals_attempted,h.free_throws_made,h.free_throws_attempted,
          CASE WHEN h.double_double THEN 1 ELSE 0 END,CASE WHEN h.triple_double THEN 1 ELSE 0 END,c.scoring_settings)
          ORDER BY h.game_date,h.id) FROM (
            SELECT s.* FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
            WHERE s.player_id=r.player_id AND NOT s.did_not_play AND g.status='Final'
              AND s.game_date<v_today AND s.season_year BETWEEN c.season_year-1 AND c.season_year
              AND public.is_regular_season_game_id(g.nba_game_id)
            ORDER BY s.game_date DESC,s.id LIMIT 30
          ) h)
      FROM unnest(v_missing) r(player_id)
      ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET observed_date=EXCLUDED.observed_date,
        revision=EXCLUDED.revision,scoring_hash=EXCLUDED.scoring_hash,scores=EXCLUDED.scores;
    END IF;
    DELETE FROM private.forecast_projection_inputs p WHERE p.matchup_id=p_matchup_id AND p.game_date<v_today;
    RETURN COALESCE((SELECT jsonb_agg(d.game_date ORDER BY d.game_date) FROM unnest(v_dates) d(game_date)
      LEFT JOIN private.forecast_projection_inputs p ON p.matchup_id=p_matchup_id AND p.game_date=d.game_date
      WHERE p.matchup_id IS NULL OR p.observed_date<>v_today OR p.revision<>v_projection_revision
        OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>v_roster_hash OR p.valid_until<=now()),'[]'::jsonb);
  END IF;
  IF NOT p_game_date=ANY(v_dates) THEN RETURN '[]'::jsonb; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('requested_date',p_game_date,'player_id',p.player_id,
    'projection_fantasy_points',p.projection_fantasy_points,'projection_source_label',p.projection_source_label,
    'projection_fetched_at',p.projection_fetched_at,'projection_date',p.projection_date,
    'projection_is_fresh',p.projection_is_fresh) ORDER BY p.player_id),'[]'::jsonb) INTO v_rows
  FROM public.get_league_projection_rows(c.league_id,c.season_year,p_game_date,'today',v_ids,100,0) p;
  SELECT LEAST((v_today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.game_time>now()),
    (SELECT min(g.started_at) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.started_at>now()),
    (SELECT min(r.fetched_at+interval '36 hours') FROM public.sleeper_projection_rows r WHERE r.player_id=ANY(v_ids) AND r.fetched_at+interval '36 hours'>now()),
    (SELECT min(r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END)
      FROM public.fantasypros_projection_rows r WHERE r.player_id=ANY(v_ids)
        AND r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END>now())) INTO v_expires;
  INSERT INTO private.forecast_projection_inputs(matchup_id,game_date,observed_date,revision,scoring_hash,roster_hash,valid_until,rows)
    VALUES(p_matchup_id,p_game_date,v_today,v_projection_revision,c.scoring_hash,v_roster_hash,v_expires,v_rows)
  ON CONFLICT(matchup_id,game_date) DO UPDATE SET observed_date=EXCLUDED.observed_date,revision=EXCLUDED.revision,
    scoring_hash=EXCLUDED.scoring_hash,roster_hash=EXCLUDED.roster_hash,valid_until=EXCLUDED.valid_until,rows=EXCLUDED.rows;
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION private.read_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,m.home_points,m.away_points,m.is_finalized,
    s.season_year,w.week_start,e.week_end,now() AS observed_at,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m
  JOIN public.leagues l ON l.id=m.league_id
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
    AND g.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  WHERE public.is_regular_season_game_id(g.nba_game_id)
), history AS (
  SELECT h.player_id,h.scores FROM context c CROSS JOIN roster r
  JOIN private.forecast_player_history h ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
  WHERE cardinality(h.scores)>0
), projections AS (
  SELECT p.game_date,item.ordinality,
    CASE WHEN item.value->>'projection_source_label'='Season Avg'
      THEN jsonb_set(item.value,'{projection_fantasy_points}',COALESCE(to_jsonb(a.fantasy_points),'null'::jsonb))
      ELSE item.value END AS projection
  FROM context c JOIN private.forecast_projection_inputs p ON p.matchup_id=c.id
  CROSS JOIN LATERAL jsonb_array_elements(p.rows) WITH ORDINALITY item(value,ordinality)
  LEFT JOIN private.forecast_season_points a ON a.league_id=c.league_id AND a.season_year=c.season_year
    AND a.player_id=(item.value->>'player_id')::uuid
  WHERE p.game_date IN (SELECT DISTINCT game_date FROM games WHERE status NOT IN('Final','Postponed','Cancelled'))
)
SELECT jsonb_build_object(
  'matchupId',c.id,'observedAt',c.observed_at,'today',c.today,'weekEnd',c.week_end,'isFinalized',c.is_finalized,
  'teams',jsonb_build_array(jsonb_build_object('memberId',c.home_member_id,'currentPoints',COALESCE(c.home_points,0)),
    jsonb_build_object('memberId',c.away_member_id,'currentPoints',COALESCE(c.away_points,0))),
  'roster',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id) FROM roster r),'[]'::jsonb),
  'games',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.game_date,g.id) FROM games g),'[]'::jsonb),
  'history',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.player_id) FROM history h),'[]'::jsonb),
  'projections',COALESCE((SELECT jsonb_agg(p.projection ORDER BY p.game_date,p.ordinality) FROM projections p),'[]'::jsonb),
  'lineups',COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id',l.member_id,'player_id',l.player_id,
    'game_date',l.game_date,'slot_type',l.slot_type,'is_auto_set',l.is_auto_set) ORDER BY l.game_date,l.member_id,l.player_id)
    FROM public.weekly_lineups l WHERE l.league_season_id=c.league_season_id
      AND l.member_id IN(c.home_member_id,c.away_member_id) AND l.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end),'[]'::jsonb),
  'templates',COALESCE((SELECT jsonb_agg(jsonb_build_object('slot_type',t.slot_type,'slot_count',t.slot_count) ORDER BY t.slot_type)
    FROM public.lineup_slot_templates t WHERE t.league_id=c.league_id AND t.slot_type NOT IN('BE','IR')),'[]'::jsonb),
  'automaticMembers',COALESCE((SELECT jsonb_agg(s.member_id ORDER BY s.member_id)
    FROM public.lineup_optimizer_settings s WHERE s.league_season_id=c.league_season_id
      AND s.member_id IN(c.home_member_id,c.away_member_id) AND s.enabled),'[]'::jsonb),
  'previous',COALESCE((SELECT f.forecast FROM public.matchup_forecasts f WHERE f.matchup_id=c.id),'null'::jsonb)
) FROM context c;
$$;

CREATE OR REPLACE FUNCTION public.get_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.matchup_forecast_inputs_ready(p_matchup_id)
    THEN private.read_matchup_forecast_context(p_matchup_id)
    ELSE private.compute_matchup_forecast_context(p_matchup_id) END;
$$;

CREATE OR REPLACE FUNCTION public.get_prepared_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.matchup_forecast_inputs_ready(p_matchup_id) THEN
    RAISE EXCEPTION 'Forecast inputs changed. Prepare them again.' USING ERRCODE='PT409';
  END IF;
  RETURN private.read_matchup_forecast_context(p_matchup_id);
END;
$$;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.player_game_stats','public.nba_games','public.players','public.leagues',
    'public.player_projections','public.fantasypros_projection_rows','public.sleeper_projection_rows',
    'public.projection_sync_runs','public.season_weeks','analytics.search_cache_refresh_state'] LOOP
    EXECUTE format('CREATE TRIGGER forecast_inputs_insert AFTER INSERT ON %s REFERENCING NEW TABLE AS forecast_new FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_forecast_inputs()',target);
    EXECUTE format('CREATE TRIGGER forecast_inputs_update AFTER UPDATE ON %s REFERENCING OLD TABLE AS forecast_old NEW TABLE AS forecast_new FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_forecast_inputs()',target);
    EXECUTE format('CREATE TRIGGER forecast_inputs_delete AFTER DELETE ON %s REFERENCING OLD TABLE AS forecast_old FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_forecast_inputs()',target);
    EXECUTE format('CREATE TRIGGER forecast_inputs_truncate AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION private.invalidate_forecast_inputs()',target);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION private.compute_matchup_forecast_context(uuid),private.read_matchup_forecast_context(uuid),private.matchup_forecast_inputs_ready(uuid),private.invalidate_forecast_inputs() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.prepare_matchup_forecast_inputs(uuid,date),public.get_prepared_matchup_forecast_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_matchup_forecast_inputs(uuid,date),public.get_prepared_matchup_forecast_context(uuid) TO service_role;
ANALYZE private.forecast_player_history;
ANALYZE private.forecast_projection_inputs;
CREATE TRIGGER forecast_totals_insert AFTER INSERT ON analytics.player_season_totals REFERENCING NEW TABLE AS forecast_new
  FOR EACH STATEMENT EXECUTE FUNCTION private.update_forecast_season_points();
CREATE TRIGGER forecast_totals_update AFTER UPDATE ON analytics.player_season_totals REFERENCING OLD TABLE AS forecast_old NEW TABLE AS forecast_new
  FOR EACH STATEMENT EXECUTE FUNCTION private.update_forecast_season_points();
CREATE TRIGGER forecast_totals_delete AFTER DELETE ON analytics.player_season_totals REFERENCING OLD TABLE AS forecast_old
  FOR EACH STATEMENT EXECUTE FUNCTION private.update_forecast_season_points();
CREATE TRIGGER forecast_totals_truncate AFTER TRUNCATE ON analytics.player_season_totals
  FOR EACH STATEMENT EXECUTE FUNCTION private.update_forecast_season_points();
REVOKE ALL ON FUNCTION private.update_forecast_season_points() FROM PUBLIC,anon,authenticated,service_role;
