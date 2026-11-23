CREATE OR REPLACE FUNCTION private.enqueue_player_injuries(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date:=(p_now AT TIME ZONE 'America/New_York')::date;
  v_first_tipoff timestamptz; v_last_tipoff timestamptz; v_key text;
BEGIN
  SELECT min(game_time),max(game_time) INTO v_first_tipoff,v_last_tipoff FROM public.nba_games
    WHERE game_date=v_today AND private.lineup_game_available(status,game_status_text);
  IF v_first_tipoff IS NULL THEN
    IF (p_now AT TIME ZONE 'America/New_York')::time<time '08:00' THEN RETURN; END IF;
    v_key:=v_today::text;
  ELSIF p_now BETWEEN v_first_tipoff-interval '2 hours' AND v_last_tipoff THEN
    v_key:=date_bin(interval '15 minutes',p_now,timestamptz '2000-01-01 00:00 UTC')::text;
  ELSIF p_now<v_first_tipoff-interval '2 hours' THEN
    v_key:=date_trunc('hour',p_now)::text;
  ELSE RETURN;
  END IF;
  PERFORM private.work_enqueue('player-injuries',v_key,p_now);
END;
$$;

CREATE OR REPLACE FUNCTION private.projection_sync_due_work(p_now timestamptz DEFAULT now())
RETURNS TABLE(job_key text, period_key text, function_name text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH clock AS (
    SELECT (p_now AT TIME ZONE 'America/Los_Angeles')::date AS today,
      (p_now AT TIME ZONE 'America/Los_Angeles')::time AS local_time,
      extract(year FROM p_now AT TIME ZONE 'America/Los_Angeles')::integer
        +(extract(month FROM p_now AT TIME ZONE 'America/Los_Angeles')>=10)::integer AS season_year
  ), calendar AS (
    SELECT clock.*,min(game.game_time) AS first_tipoff FROM clock
    LEFT JOIN public.nba_games game ON game.game_date=clock.today AND game.season_year=clock.season_year
      AND private.lineup_game_available(game.status,game.game_status_text) AND public.is_regular_season_game_id(game.nba_game_id)
    GROUP BY today,local_time,clock.season_year
  ), periods AS (
    SELECT *,today::text||CASE WHEN p_now>=first_tipoff-interval '1 hour' THEN ':pregame' ELSE ':08' END AS period
    FROM calendar WHERE (local_time>=time '08:00' AND local_time<time '09:00' AND (first_tipoff IS NULL OR p_now<first_tipoff))
      OR p_now>=first_tipoff-interval '1 hour' AND p_now<first_tipoff
  )
  SELECT 'pt:sleeper-day',period,'sync-sleeper-projections' FROM periods
    WHERE EXISTS(SELECT 1 FROM public.season_weeks week WHERE week.season_year=periods.season_year
      AND periods.today BETWEEN week.week_start AND week.week_end)
  UNION ALL
  SELECT 'pt:fantasypros',period,'sync-projections' FROM periods;
$$;

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
  WHERE public.is_regular_season_game_id(g.nba_game_id) AND private.lineup_game_available(g.status,g.game_status_text)
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
  FROM context c CROSS JOIN (SELECT DISTINCT game_date FROM games WHERE status<>'Final') d
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
  WHERE public.is_regular_season_game_id(g.nba_game_id) AND private.lineup_game_available(g.status,g.game_status_text)
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
  WHERE p.game_date IN (SELECT DISTINCT game_date FROM games WHERE status<>'Final')
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
  WHERE public.is_regular_season_game_id(g.nba_game_id) AND g.status<>'Final' AND private.lineup_game_available(g.status,g.game_status_text)
    AND (p.matchup_id IS NULL OR p.observed_date<>c.today OR p.revision<>c.projection_revision
      OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>r.fingerprint OR p.valid_until<=now())
);
$$;

CREATE OR REPLACE FUNCTION public.prepare_matchup_forecast_inputs(p_matchup_id uuid,p_game_date date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record; v_ids uuid[]; v_missing uuid[]; v_roster_hash text; v_history_revision bigint;
  v_projection_revision bigint; v_dates date[]; v_game_date date; v_rows jsonb; v_expires timestamptz;
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
    AND public.is_regular_season_game_id(g.nba_game_id) AND g.status<>'Final' AND private.lineup_game_available(g.status,g.game_status_text);
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
            SELECT s.* FROM public.player_game_stats s
            WHERE s.player_id=r.player_id AND NOT s.did_not_play
              AND s.game_date<v_today AND s.season_year BETWEEN c.season_year-1 AND c.season_year
              AND (SELECT g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)
                FROM public.nba_games g WHERE g.id=s.game_id)
            ORDER BY s.game_date DESC,s.id LIMIT 30
          ) h)
      FROM unnest(v_missing) r(player_id)
      ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET observed_date=EXCLUDED.observed_date,
        revision=EXCLUDED.revision,scoring_hash=EXCLUDED.scoring_hash,scores=EXCLUDED.scores;
    END IF;
    DELETE FROM private.forecast_projection_inputs p WHERE p.matchup_id=p_matchup_id AND p.game_date<v_today;
  END IF;
  SELECT COALESCE(array_agg(d.game_date ORDER BY d.game_date),'{}'::date[]) INTO v_dates
  FROM unnest(v_dates) d(game_date)
  LEFT JOIN private.forecast_projection_inputs p ON p.matchup_id=p_matchup_id AND p.game_date=d.game_date
  WHERE (p_game_date IS NULL OR d.game_date=p_game_date)
    AND (p.matchup_id IS NULL OR p.observed_date<>v_today OR p.revision<>v_projection_revision
      OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>v_roster_hash OR p.valid_until<=now());
  IF cardinality(v_dates)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT LEAST((v_today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.game_time>now()),
    (SELECT min(g.started_at) FROM public.nba_games g WHERE g.season_year=c.season_year AND g.started_at>now()),
    (SELECT min(r.fetched_at+interval '36 hours') FROM public.sleeper_projection_rows r WHERE r.player_id=ANY(v_ids) AND r.fetched_at+interval '36 hours'>now()),
    (SELECT min(r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END)
      FROM public.fantasypros_projection_rows r WHERE r.player_id=ANY(v_ids)
        AND r.fetched_at+CASE WHEN r.projection_type='daily' THEN interval '36 hours' ELSE interval '8 days' END>now())) INTO v_expires;
  FOREACH v_game_date IN ARRAY v_dates LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object('requested_date',v_game_date,'player_id',p.player_id,
      'projection_fantasy_points',p.projection_fantasy_points,'projection_source_label',p.projection_source_label,
      'projection_fetched_at',p.projection_fetched_at,'projection_date',p.projection_date,
      'projection_is_fresh',p.projection_is_fresh) ORDER BY p.player_id),'[]'::jsonb) INTO v_rows
    FROM public.get_league_projection_rows(c.league_id,c.season_year,v_game_date,'today',v_ids,100,0) p;
    INSERT INTO private.forecast_projection_inputs AS stored(matchup_id,game_date,observed_date,revision,scoring_hash,roster_hash,valid_until,rows)
      VALUES(p_matchup_id,v_game_date,v_today,v_projection_revision,c.scoring_hash,v_roster_hash,v_expires,v_rows)
    ON CONFLICT(matchup_id,game_date) DO UPDATE SET observed_date=EXCLUDED.observed_date,revision=EXCLUDED.revision,
      scoring_hash=EXCLUDED.scoring_hash,roster_hash=EXCLUDED.roster_hash,valid_until=EXCLUDED.valid_until,rows=EXCLUDED.rows
      WHERE ROW(stored.observed_date,stored.revision,stored.scoring_hash,stored.roster_hash,stored.valid_until,stored.rows)
        IS DISTINCT FROM ROW(EXCLUDED.observed_date,EXCLUDED.revision,EXCLUDED.scoring_hash,EXCLUDED.roster_hash,EXCLUDED.valid_until,EXCLUDED.rows);
  END LOOP;
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_compact_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE value jsonb:=public.get_prepared_matchup_forecast_context(p_matchup_id);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'games') game WHERE COALESCE(game->>'status','')<>'Final') THEN
    value:=value||jsonb_build_object('roster','[]'::jsonb,'history','[]'::jsonb,'projections','[]'::jsonb,
      'lineups','[]'::jsonb,'templates','[]'::jsonb,'seasonAverages','[]'::jsonb,'previous',NULL);
  END IF;
  RETURN (value-ARRAY['teams','roster','games','history','projections','lineups','templates','seasonAverages','previous'])||jsonb_build_object(
    'wireVersion',1,
    'teams',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'memberId',item->'currentPoints') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'teams') WITH ORDINALITY entries(item,n)),
    'roster',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'member_id',item->'player_id',item->'is_on_ir',item->'is_on_taxi',item->'nba_team',item->'eligible_positions',item->'injury_status') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'roster') WITH ORDINALITY entries(item,n)),
    'games',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'id',item->'game_date',item->'home_team',item->'away_team',item->'status',item->'game_time',item->'started_at',item->'live_scoreboard_elapsed_seconds',item->'live_stats_elapsed_seconds') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'games') WITH ORDINALITY entries(item,n)),
    'history',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'player_id',item->'scores') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'history') WITH ORDINALITY entries(item,n)),
    'projections',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'requested_date',item->'player_id',item->'projection_fantasy_points',item->'projection_source_label',item->'projection_fetched_at',item->'projection_date',item->'projection_is_fresh') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'projections') WITH ORDINALITY entries(item,n)),
    'lineups',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'member_id',item->'player_id',item->'game_date',item->'slot_type',item->'is_auto_set') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'lineups') WITH ORDINALITY entries(item,n)),
    'templates',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'slot_type',item->'slot_count') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'templates') WITH ORDINALITY entries(item,n)),
    'seasonAverages',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'player_id',item->'avg_fantasy_points') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'seasonAverages') WITH ORDINALITY entries(item,n)),
    'previous',CASE WHEN jsonb_typeof(value->'previous')='object' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'playerId',item->'gameId',item->'projection',item->'source',item->'sourceAt',item->'substituted') ORDER BY n),'[]')
        FROM jsonb_array_elements(COALESCE(value->'previous'->'games','[]')) WITH ORDINALITY entries(item,n))
      ELSE 'null'::jsonb END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_visible_player_totals(
  p_league_id uuid,
  p_player_ids uuid[],
  p_season_year integer DEFAULT public.current_season_year_et()
)
RETURNS TABLE (
  player_id uuid,
  totals jsonb,
  rounded_fantasy_average numeric,
  game_status text,
  game_time timestamptz,
  started_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_scoring jsonb;
  v_needs_rounding boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.league_members m
    WHERE m.league_id = p_league_id AND m.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'You do not belong to this league.' USING ERRCODE = '42501';
  END IF;
  IF p_player_ids IS NULL OR cardinality(p_player_ids) > 50 THEN
    RAISE EXCEPTION 'Choose at most 50 visible players.' USING ERRCODE = '22023';
  END IF;
  SELECT l.scoring_settings INTO v_scoring FROM public.leagues l WHERE l.id = p_league_id;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_each_text(v_scoring) coefficient
    WHERE coefficient.key IN ('points','rebounds','assists','steals','blocks','turnovers',
      'three_pointers_made','field_goals_made','field_goals_attempted',
      'free_throws_made','free_throws_attempted','double_double','triple_double')
      AND coefficient.value::numeric <> round(coefficient.value::numeric, 2)
  ) INTO v_needs_rounding;
  RETURN QUERY
  WITH today_games AS MATERIALIZED (
    SELECT g.id, g.home_team, g.away_team, g.status, g.game_time, g.started_at
    FROM public.nba_games g
    WHERE g.game_date = (now() AT TIME ZONE 'America/New_York')::date
      AND g.season_year = p_season_year AND g.nba_game_id LIKE '002%'
      AND private.lineup_game_available(g.status, g.game_status_text)
  )
  SELECT p.id, COALESCE(to_jsonb(t) - 'player_id' - 'season_year', '{}'::jsonb),
    CASE WHEN v_needs_rounding THEN (
      SELECT round(avg(fp.fantasy_points), 2)
      FROM public.v_fantasy_points fp
      JOIN public.player_game_stats stat ON stat.id = fp.stat_id AND NOT stat.did_not_play
      WHERE fp.league_id = p_league_id AND fp.player_id = p.id AND fp.season_year = p_season_year
    ) ELSE NULL::numeric END,
    game.status::text, game.game_time, game.started_at
  FROM public.players p
  LEFT JOIN analytics.player_season_totals t ON t.player_id = p.id AND t.season_year = p_season_year
  LEFT JOIN LATERAL (
    SELECT g.status, g.game_time, g.started_at
    FROM today_games g
    WHERE p.nba_team IN (g.home_team, g.away_team)
    ORDER BY g.game_time NULLS LAST, g.id LIMIT 1
  ) game ON true
  WHERE p.id = ANY(p_player_ids);
END;
$$;
