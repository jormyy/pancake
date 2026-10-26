CREATE TABLE private.matchup_forecast_queue (
  matchup_id uuid PRIMARY KEY REFERENCES public.matchups(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now(),
  dirty boolean NOT NULL DEFAULT true,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_revision bigint,
  claim_token uuid,
  last_error text
);

CREATE INDEX matchup_forecast_due ON private.matchup_forecast_queue(available_at,changed_at) WHERE dirty;

CREATE TABLE public.matchup_forecasts (
  matchup_id uuid PRIMARY KEY REFERENCES public.matchups(id) ON DELETE CASCADE,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  input_revision bigint NOT NULL,
  forecast jsonb NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL
);

CREATE INDEX matchup_forecasts_expiry ON public.matchup_forecasts(valid_until);
ALTER TABLE public.matchup_forecasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY matchup_forecasts_member_read ON public.matchup_forecasts FOR SELECT TO authenticated
  USING(private.is_league_member(league_id));
REVOKE ALL ON private.matchup_forecast_queue FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.matchup_forecasts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.matchup_forecasts TO authenticated;
GRANT ALL ON public.matchup_forecasts,private.matchup_forecast_queue TO service_role;

CREATE OR REPLACE FUNCTION private.queue_matchup_forecasts(p_league_id uuid DEFAULT NULL, p_matchup_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.matchup_forecast_queue AS queued(matchup_id, revision, changed_at, dirty)
  SELECT matchup.id, 1, transaction_timestamp(), true
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
    revision=CASE WHEN queued.changed_at=transaction_timestamp() THEN queued.revision ELSE queued.revision+1 END,
    changed_at=transaction_timestamp(), dirty=true, available_at=now();
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
  ELSIF NEW.topic IN ('lineup','roster','score','game','stat','player_stats','resources')
    OR NEW.topic='inventory' AND (NEW.details IS NULL OR NEW.details @> '[{"resource":"season"}]'::jsonb) THEN
    PERFORM private.queue_matchup_forecasts(NEW.league_id);
  END IF;
  RETURN NEW;
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
  UPDATE private.matchup_forecast_queue queued SET claim_token=gen_random_uuid(),claimed_at=now(),claimed_revision=queued.revision
  FROM candidates WHERE queued.matchup_id=candidates.matchup_id
  RETURNING queued.matchup_id,queued.revision,queued.claim_token;
$$;

CREATE OR REPLACE FUNCTION public.complete_matchup_forecast(
  p_matchup_id uuid, p_revision bigint, p_claim_token uuid, p_forecast jsonb, p_valid_until timestamptz
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.matchup_forecast_queue%ROWTYPE; league_id uuid;
BEGIN
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
  SELECT matchup.league_id INTO STRICT league_id FROM public.matchups matchup WHERE matchup.id=p_matchup_id;
  INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
  VALUES(p_matchup_id,league_id,p_revision,p_forecast,now(),GREATEST(COALESCE(p_valid_until,now()+interval '1 day'),now()+interval '1 second'))
  ON CONFLICT(matchup_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,forecast=EXCLUDED.forecast,
    calculated_at=EXCLUDED.calculated_at,valid_until=EXCLUDED.valid_until;
  UPDATE private.matchup_forecast_queue SET dirty=false,claim_token=NULL,claimed_at=NULL,claimed_revision=NULL,last_error=NULL
  WHERE matchup_id=p_matchup_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_matchup_forecast(p_matchup_id uuid,p_claim_token uuid,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.matchup_forecast_queue SET claimed_at=NULL,claim_token=NULL,claimed_revision=NULL,
    available_at=now()+interval '1 minute',last_error=left(p_error,1000)
  WHERE matchup_id=p_matchup_id AND claim_token=p_claim_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_matchup_forecast(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.matchups matchup
    JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
    JOIN public.league_members member ON member.league_id=league.id AND member.user_id=auth.uid()
    WHERE matchup.id=p_matchup_id
  ) THEN RAISE EXCEPTION 'This matchup is not available.' USING ERRCODE='42501'; END IF;
  SELECT cached.forecast||jsonb_build_object('matchupId',cached.matchup_id,'calculatedAt',cached.calculated_at,
    'inputRevision',cached.input_revision,'stale',COALESCE(queued.dirty,false) OR cached.valid_until<=now())
  INTO result FROM public.matchup_forecasts cached
  LEFT JOIN private.matchup_forecast_queue queued ON queued.matchup_id=cached.matchup_id
  WHERE cached.matchup_id=p_matchup_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_matchup_forecasts_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.matchup_forecast_queue(matchup_id)
  SELECT matchup.id FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE NOT matchup.is_voided AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1
    AND first_week.week_start<=(now() AT TIME ZONE 'America/New_York')::date+14
    AND NOT EXISTS(SELECT 1 FROM private.matchup_forecast_queue queued WHERE queued.matchup_id=matchup.id)
  ORDER BY matchup.id ON CONFLICT DO NOTHING;
  UPDATE private.matchup_forecast_queue queued SET dirty=true,revision=queued.revision+1,changed_at=now(),available_at=now()
  FROM public.matchup_forecasts cached JOIN public.matchups matchup ON matchup.id=cached.matchup_id
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  WHERE queued.matchup_id=cached.matchup_id AND NOT queued.dirty AND cached.valid_until<=now()
    AND last_week.week_end>=(now() AT TIME ZONE 'America/New_York')::date-1 AND NOT matchup.is_voided;
  IF EXISTS(SELECT 1 FROM private.matchup_forecast_queue WHERE dirty AND available_at<=now()
    AND (claimed_at IS NULL OR claimed_at<now()-interval '3 minutes')) THEN
    PERFORM public.invoke_edge_function('matchup-forecast');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.queue_matchup_forecasts(uuid,uuid),private.queue_changed_matchup_forecasts() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_matchup_forecasts(integer),public.complete_matchup_forecast(uuid,bigint,uuid,jsonb,timestamptz),public.fail_matchup_forecast(uuid,uuid,text),public.invoke_matchup_forecasts_if_due() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_matchup_forecasts(integer),public.complete_matchup_forecast(uuid,bigint,uuid,jsonb,timestamptz),public.fail_matchup_forecast(uuid,uuid,text),public.invoke_matchup_forecasts_if_due() TO service_role;
REVOKE ALL ON FUNCTION public.get_matchup_forecast(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_matchup_forecast(uuid) TO authenticated;

CREATE TRIGGER queue_forecasts_from_hints AFTER INSERT OR UPDATE ON public.league_change_hints
FOR EACH ROW EXECUTE FUNCTION private.queue_changed_matchup_forecasts();
CREATE TRIGGER queue_forecasts_from_matchups AFTER INSERT OR UPDATE OF week_number,end_week_number,home_member_id,away_member_id,home_points,away_points,is_finalized,is_voided ON public.matchups
FOR EACH ROW EXECUTE FUNCTION private.queue_changed_matchup_forecasts();
CREATE TRIGGER queue_forecasts_from_optimizer AFTER INSERT OR UPDATE OR DELETE ON public.lineup_optimizer_settings
FOR EACH ROW EXECUTE FUNCTION private.queue_changed_matchup_forecasts();
CREATE TRIGGER queue_forecasts_from_templates AFTER INSERT OR UPDATE OR DELETE ON public.lineup_slot_templates
FOR EACH ROW EXECUTE FUNCTION private.queue_changed_matchup_forecasts();
CREATE TRIGGER queue_forecasts_from_availability AFTER UPDATE OF injury_status,nba_team,position,eligible_positions ON public.players
FOR EACH ROW WHEN ((OLD.injury_status,OLD.nba_team,OLD.position,OLD.eligible_positions) IS DISTINCT FROM (NEW.injury_status,NEW.nba_team,NEW.position,NEW.eligible_positions))
EXECUTE FUNCTION private.queue_changed_matchup_forecasts();

ALTER PUBLICATION supabase_realtime ADD TABLE public.matchup_forecasts;
SELECT cron.schedule('matchup-forecasts','* * * * *','SELECT public.invoke_matchup_forecasts_if_due()');
SELECT private.queue_matchup_forecasts();

CREATE OR REPLACE FUNCTION public.get_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.*,s.season_year,w.week_start,e.week_end,now() AS observed_at,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m
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
  SELECT r.player_id,array_agg(public.compute_fantasy_points(h.id,c.league_id) ORDER BY h.game_date,h.id) AS scores
  FROM context c CROSS JOIN roster r
  CROSS JOIN LATERAL (
    SELECT pgs.id,g.game_date FROM public.player_game_stats pgs
    JOIN public.nba_games g ON g.id=pgs.game_id
    WHERE pgs.player_id=r.player_id AND NOT pgs.did_not_play AND g.status='Final'
      AND g.game_date<c.today AND g.season_year BETWEEN c.season_year-1 AND c.season_year
      AND public.is_regular_season_game_id(g.nba_game_id)
    ORDER BY g.game_date DESC,pgs.id LIMIT 30
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

REVOKE ALL ON FUNCTION public.get_matchup_forecast_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_matchup_forecast_context(uuid) TO service_role;
