ALTER TABLE private.matchup_forecast_queue
  ADD COLUMN input_fingerprint jsonb,
  ADD COLUMN claimed_fingerprint jsonb,
  ADD COLUMN computed_fingerprint jsonb;
ALTER TABLE private.forecast_input_revisions DROP CONSTRAINT forecast_input_revisions_kind_check;
ALTER TABLE private.forecast_input_revisions ADD CONSTRAINT forecast_input_revisions_kind_check CHECK(kind IN('history','projection','source'));
INSERT INTO private.forecast_input_revisions(kind) VALUES('source');
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
  'validUntil',LEAST(now()+interval '6 hours',(c.today+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(g.game_time) FROM games g WHERE g.game_time>now()),
    (SELECT min(g.started_at) FROM games g WHERE g.started_at>now()),
    (SELECT min(f.expires) FROM freshness f WHERE f.expires>=now()))
) FROM context c;
$$;

CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL, p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.matchup_forecast_queue AS queued(matchup_id, revision, changed_at, dirty, input_fingerprint)
  SELECT matchup.id, 1, transaction_timestamp(), true,private.matchup_forecast_input_fingerprint(matchup.id)
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided
    AND (p_league_id IS NULL OR matchup.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR matchup.id=p_matchup_id)
    AND last_week.week_end >= (now() AT TIME ZONE 'America/New_York')::date - 1
    AND first_week.week_start <= (now() AT TIME ZONE 'America/New_York')::date + 14
  ORDER BY matchup.id
  ON CONFLICT(matchup_id) DO UPDATE SET
    revision=queued.revision+CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN 1 ELSE 0 END,
    changed_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN transaction_timestamp() ELSE queued.changed_at END,
    dirty=queued.computed_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs',
    available_at=CASE WHEN queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs' THEN now() ELSE queued.available_at END,
    input_fingerprint=EXCLUDED.input_fingerprint
  WHERE queued.input_fingerprint->>'inputs' IS DISTINCT FROM EXCLUDED.input_fingerprint->>'inputs'
    OR (queued.input_fingerprint->>'validUntil')::timestamptz<=now();
  UPDATE public.matchup_forecasts cached SET valid_until=GREATEST((queued.input_fingerprint->>'validUntil')::timestamptz,now()+interval '1 second')
  FROM private.matchup_forecast_queue queued WHERE cached.matchup_id=queued.matchup_id
    AND NOT queued.dirty AND cached.valid_until<=now()
    AND (p_league_id IS NULL OR cached.league_id=p_league_id)
    AND (p_matchup_id IS NULL OR cached.matchup_id=p_matchup_id);
$$;

CREATE OR REPLACE FUNCTION private.queue_changed_matchup_forecasts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected_league uuid;
BEGIN
  IF TG_TABLE_NAME='matchups' THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id,NEW.id);
  ELSIF TG_TABLE_NAME IN ('lineup_optimizer_settings','lineup_slot_templates') THEN
    IF TG_OP='DELETE' THEN PERFORM private.queue_matchup_forecasts(OLD.league_id);
    ELSE PERFORM private.queue_matchup_forecasts(NEW.league_id); END IF;
  ELSIF TG_TABLE_NAME='players' THEN
    FOR affected_league IN SELECT DISTINCT roster.league_id FROM public.roster_players roster
      WHERE roster.player_id=NEW.id ORDER BY roster.league_id LOOP
      PERFORM private.queue_matchup_forecasts(affected_league);
    END LOOP;
  ELSIF NEW.topic IN ('lineup','roster','score')
    OR NEW.topic='inventory' AND (NEW.details IS NULL OR NEW.details @> '[{"resource":"season"}]'::jsonb) THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_matchup_forecasts(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE expired record;
BEGIN
  INSERT INTO private.matchup_forecast_queue(matchup_id,input_fingerprint)
  SELECT matchup.id,private.matchup_forecast_input_fingerprint(matchup.id) FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1
    AND first_week.week_start<=(p_now AT TIME ZONE 'America/New_York')::date+14
    AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue queued WHERE queued.matchup_id=matchup.id)
  ORDER BY matchup.id ON CONFLICT DO NOTHING;
  FOR expired IN
    SELECT matchup.id FROM private.matchup_forecast_queue queued
    JOIN public.matchup_forecasts cached ON cached.matchup_id=queued.matchup_id
    JOIN public.matchups matchup ON matchup.id=cached.matchup_id
    JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    WHERE NOT queued.dirty AND cached.valid_until<=p_now
      AND last_week.week_end>=(p_now AT TIME ZONE 'America/New_York')::date-1 AND NOT matchup.is_voided
    ORDER BY matchup.id
  LOOP
    PERFORM private.queue_matchup_forecasts(NULL,expired.id);
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=p_now
    AND (claimed_at IS NULL OR claimed_at<p_now-interval '3 minutes')) THEN
    PERFORM private.work_enqueue('matchup-forecasts',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.invalidate_forecast_inputs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_history boolean:=false; v_projection boolean:=false; v_source boolean:=false;
  v_today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  IF TG_TABLE_NAME='search_cache_refresh_state' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' AND TG_TABLE_NAME IN('projection_sync_runs','fantasypros_projection_rows','sleeper_projection_rows')
    AND current_setting('pancake.projection_cleanup',true)='on' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME IN('player_projections','fantasypros_projection_rows','sleeper_projection_rows','projection_sync_runs') THEN
    IF TG_OP='TRUNCATE' THEN v_source:=true;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (to_jsonb(o)-ARRAY['updated_at','created_at']) IS DISTINCT FROM (to_jsonb(n)-ARRAY['updated_at','created_at'])
          AND EXISTS(SELECT 1 FROM public.projection_sync_runs r WHERE r.id IN(o.run_id,n.run_id)
            AND r.status='success' AND r.completed_at IS NOT NULL)) INTO v_source;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='INSERT' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new n JOIN public.projection_sync_runs r ON r.id=n.run_id
        WHERE r.status='success' AND r.completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='fantasypros_projection_rows' AND TG_OP='DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN public.projection_sync_runs r ON r.id=o.run_id
        WHERE r.status='success' AND r.completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (o.status='success' AND o.completed_at IS NOT NULL OR n.status='success' AND n.completed_at IS NOT NULL)
          AND (o.source,o.projection_type,o.projection_date,o.season_year,o.week_number,o.status,o.started_at,o.completed_at)
            IS DISTINCT FROM (n.source,n.projection_type,n.projection_date,n.season_year,n.week_number,n.status,n.started_at,n.completed_at)) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='INSERT' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_new WHERE status='success' AND completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_TABLE_NAME='projection_sync_runs' AND TG_OP='DELETE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old WHERE status='success' AND completed_at IS NOT NULL) INTO v_source;
    ELSIF TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT to_jsonb(n)-ARRAY['updated_at','created_at'] FROM forecast_new n
        EXCEPT SELECT to_jsonb(o)-ARRAY['updated_at','created_at'] FROM forecast_old o) INTO v_source;
    ELSIF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM forecast_new) INTO v_source;
    ELSE SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_source;
    END IF;
    IF NOT v_source THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    v_history:=TG_TABLE_NAME IN('player_game_stats','nba_games');
    v_projection:=TG_TABLE_NAME<>'player_game_stats';
  ELSIF TG_TABLE_NAME='player_game_stats' THEN
    IF TG_OP='UPDATE' THEN
      SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
        WHERE (o.game_date<v_today OR n.game_date<v_today)
          AND EXISTS(SELECT 1 FROM public.nba_games g WHERE g.id IN(o.game_id,n.game_id)
            AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id))
          AND (to_jsonb(o)-ARRAY['updated_at','created_at','fetched_at']) IS DISTINCT FROM
            (to_jsonb(n)-ARRAY['updated_at','created_at','fetched_at'])) INTO v_history;
    ELSE
      IF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM forecast_new n JOIN public.nba_games g ON g.id=n.game_id
        WHERE n.game_date<v_today AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)) INTO v_history;
      ELSE SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN public.nba_games g ON g.id=o.game_id
        WHERE o.game_date<v_today AND g.status='Final' AND public.is_regular_season_game_id(g.nba_game_id)) INTO v_history;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='nba_games' AND TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM forecast_old o JOIN forecast_new n USING(id)
      WHERE (o.game_date<v_today OR n.game_date<v_today)
        AND (o.status='Final' OR n.status='Final')
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
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_new
        WHERE game_date<v_today AND status='Final' AND public.is_regular_season_game_id(nba_game_id)) INTO v_history; END IF;
    ELSE
      SELECT EXISTS(SELECT 1 FROM forecast_old) INTO v_projection;
      IF TG_TABLE_NAME='nba_games' THEN SELECT EXISTS(SELECT 1 FROM forecast_old
        WHERE game_date<v_today AND status='Final' AND public.is_regular_season_game_id(nba_game_id)) INTO v_history; END IF;
    END IF;
  END IF;
  UPDATE private.forecast_input_revisions SET revision=revision+1
    WHERE kind='history' AND v_history OR kind='projection' AND v_projection OR kind='source' AND v_source;
  IF v_history OR v_projection THEN PERFORM private.queue_matchup_forecasts(); END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_matchup_forecasts(p_limit integer DEFAULT 10)
RETURNS TABLE(matchup_id uuid, revision bigint, claim_token uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT queued.matchup_id FROM private.matchup_forecast_queue queued
    WHERE queued.dirty AND queued.available_at<=now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at<now()-interval '3 minutes')
    ORDER BY queued.changed_at,queued.matchup_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),25)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE private.matchup_forecast_queue queued SET claim_token=gen_random_uuid(),claimed_at=now(),claimed_revision=queued.revision,
    claimed_fingerprint=COALESCE(queued.input_fingerprint,private.matchup_forecast_input_fingerprint(queued.matchup_id))
  FROM candidates WHERE queued.matchup_id=candidates.matchup_id
  RETURNING queued.matchup_id,queued.revision,queued.claim_token;
$$;

CREATE OR REPLACE FUNCTION public.complete_matchup_forecast(
  p_matchup_id uuid, p_revision bigint, p_claim_token uuid, p_forecast jsonb, p_valid_until timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.matchup_forecast_queue%ROWTYPE; forecast_league_id uuid;
BEGIN
  SELECT league.id INTO forecast_league_id FROM public.leagues league
  JOIN public.matchups matchup ON matchup.league_id=league.id
  WHERE matchup.id=p_matchup_id FOR KEY SHARE OF league;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.matchups matchup
  WHERE matchup.id=p_matchup_id AND matchup.league_id=forecast_league_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO queued FROM private.matchup_forecast_queue WHERE matchup_id=p_matchup_id FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS DISTINCT FROM p_claim_token OR queued.claimed_revision IS DISTINCT FROM p_revision THEN RETURN false; END IF;
  IF queued.revision<>p_revision THEN
    UPDATE private.matchup_forecast_queue SET claim_token=NULL,claimed_at=NULL,claimed_revision=NULL WHERE matchup_id=p_matchup_id;
    RETURN false;
  END IF;
  IF jsonb_typeof(p_forecast) IS DISTINCT FROM 'object' OR p_forecast->>'modelVersion' IS NULL
    OR jsonb_typeof(p_forecast->'teams') IS DISTINCT FROM 'array' OR jsonb_array_length(p_forecast->'teams')<>2 THEN
    RAISE EXCEPTION 'A complete versioned forecast is required.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
  VALUES(p_matchup_id,forecast_league_id,p_revision,p_forecast,now(),GREATEST(LEAST(COALESCE(p_valid_until,now()+interval '1 day'),
    (queued.claimed_fingerprint->>'validUntil')::timestamptz),now()+interval '1 second'))
  ON CONFLICT(matchup_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,forecast=EXCLUDED.forecast,
    calculated_at=EXCLUDED.calculated_at,valid_until=EXCLUDED.valid_until;
  UPDATE private.matchup_forecast_queue SET dirty=false,claim_token=NULL,claimed_at=NULL,claimed_revision=NULL,last_error=NULL,
    computed_fingerprint=queued.claimed_fingerprint,claimed_fingerprint=NULL
  WHERE matchup_id=p_matchup_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION private.matchup_forecast_input_fingerprint(uuid) FROM PUBLIC,anon,authenticated,service_role;
SELECT private.queue_matchup_forecasts();
