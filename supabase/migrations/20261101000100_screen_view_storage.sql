CREATE TABLE private.screen_refresh_queue (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid PRIMARY KEY REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1,
  dirty boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  claimed_version bigint,
  last_error text
);

CREATE INDEX screen_refresh_due ON private.screen_refresh_queue(available_at, changed_at) WHERE dirty;

CREATE TABLE public.standings_current (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  team_name text NOT NULL,
  wins integer NOT NULL,
  losses integer NOT NULL,
  ties integer NOT NULL,
  points_for numeric NOT NULL,
  points_against numeric NOT NULL,
  max_points_for numeric NOT NULL,
  version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_season_id, member_id)
);

CREATE TABLE public.matchup_totals (
  matchup_id uuid PRIMARY KEY REFERENCES public.matchups(id) ON DELETE CASCADE,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  home_points numeric,
  away_points numeric,
  home_max_possible_points numeric,
  away_max_possible_points numeric,
  version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX matchup_totals_season ON public.matchup_totals(league_season_id);

CREATE TABLE public.player_season_averages (
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  season_year integer NOT NULL,
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  averages jsonb,
  avg_fantasy_points numeric,
  version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, season_year, player_id)
);

CREATE TABLE public.trade_value_cache (
  trade_id uuid PRIMARY KEY REFERENCES public.trades(id) ON DELETE CASCADE,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  revaluation jsonb NOT NULL,
  valid_until timestamptz NOT NULL,
  version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trade_value_cache_season ON public.trade_value_cache(league_season_id, valid_until);

ALTER TABLE public.standings_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matchup_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_season_averages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_value_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY standings_current_read ON public.standings_current FOR SELECT TO authenticated USING (private.is_league_member(league_id));
CREATE POLICY matchup_totals_read ON public.matchup_totals FOR SELECT TO authenticated USING (private.is_league_member(league_id));
CREATE POLICY player_season_averages_read ON public.player_season_averages FOR SELECT TO authenticated USING (private.is_league_member(league_id));
CREATE POLICY trade_value_cache_read ON public.trade_value_cache FOR SELECT TO authenticated USING (private.can_read_trade(trade_id));
REVOKE ALL ON private.screen_refresh_queue FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.standings_current, public.matchup_totals, public.player_season_averages, public.trade_value_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.standings_current, public.matchup_totals, public.player_season_averages, public.trade_value_cache TO authenticated;
GRANT ALL ON public.standings_current, public.matchup_totals, public.player_season_averages, public.trade_value_cache, private.screen_refresh_queue TO service_role;

CREATE OR REPLACE FUNCTION private.refresh_queue_screen_views(p_league_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.screen_refresh_queue AS queued(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  WHERE p_league_id IS NULL OR season.league_id = p_league_id
  ORDER BY season.id
  ON CONFLICT (league_season_id) DO UPDATE SET version = queued.version + 1,
    dirty = true, changed_at = now(), available_at = now();
$$;

CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_standings(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.standings_current AS cached(league_id, league_season_id, member_id, team_name, wins, losses, ties, points_for, points_against, max_points_for, version)
  SELECT p_league_id, p_season_id, member.id, COALESCE(member.team_name, 'Team'),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id = member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NOT NULL AND matchup.winner_member_id <> member.id),
    count(matchup.id) FILTER (WHERE matchup.winner_member_id IS NULL),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_points ELSE matchup.away_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.away_points ELSE matchup.home_points END), 0),
    COALESCE(sum(CASE WHEN matchup.home_member_id = member.id THEN matchup.home_max_possible_points ELSE matchup.away_max_possible_points END), 0), p_version
  FROM public.league_members member
  LEFT JOIN public.matchups matchup ON matchup.league_id = p_league_id AND matchup.league_season_id = p_season_id
    AND member.id IN (matchup.home_member_id, matchup.away_member_id)
    AND matchup.is_finalized AND NOT matchup.is_voided AND matchup.matchup_type = 'regular_season'
  WHERE member.league_id = p_league_id GROUP BY member.id
  ON CONFLICT (league_season_id, member_id) DO UPDATE SET team_name = EXCLUDED.team_name,
    wins = EXCLUDED.wins, losses = EXCLUDED.losses, ties = EXCLUDED.ties,
    points_for = EXCLUDED.points_for, points_against = EXCLUDED.points_against, max_points_for = EXCLUDED.max_points_for,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_matchup_totals(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.matchup_totals AS cached(matchup_id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, version)
  SELECT id, league_id, league_season_id, home_points, away_points, home_max_possible_points, away_max_possible_points, p_version
  FROM public.matchups WHERE league_id = p_league_id AND league_season_id = p_season_id AND NOT is_voided
  ON CONFLICT (matchup_id) DO UPDATE SET home_points = EXCLUDED.home_points, away_points = EXCLUDED.away_points,
    home_max_possible_points = EXCLUDED.home_max_possible_points, away_max_possible_points = EXCLUDED.away_max_possible_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  DELETE FROM public.matchup_totals cached WHERE cached.league_season_id = p_season_id AND cached.version < p_version
    AND NOT EXISTS (SELECT 1 FROM public.matchups matchup WHERE matchup.id = cached.matchup_id AND NOT matchup.is_voided);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer;
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year INTO STRICT selected_year FROM public.league_seasons season WHERE season.id = p_season_id;
  INSERT INTO public.player_season_averages AS cached(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
  SELECT p_league_id, p_season_id, selected_year, COALESCE(average.player_id, fantasy.player_id), to_jsonb(average), fantasy.avg_fantasy_points, p_version
  FROM (SELECT * FROM public.mv_player_season_averages average WHERE average.season_year = selected_year) average
  FULL JOIN (SELECT * FROM public.v_player_avg_fantasy_points fantasy WHERE fantasy.league_id = p_league_id AND fantasy.season_year = selected_year) fantasy
    ON fantasy.player_id = average.player_id
  ON CONFLICT (league_id, season_year, player_id) DO UPDATE SET averages = EXCLUDED.averages, avg_fantasy_points = EXCLUDED.avg_fantasy_points,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id = p_season_id AND cached.version < p_version;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_trade_values(p_league_id uuid, p_season_id uuid, p_version bigint, p_values jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Trade values must be an array.' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.trade_value_cache AS cached(trade_id, league_id, league_season_id, revaluation, valid_until, version)
  SELECT trade.id, p_league_id, p_season_id, item->'revaluation',
    LEAST(now() + interval '10 minutes', COALESCE((item->'revaluation'->>'expiresAt')::timestamptz, now() + interval '10 minutes')), p_version
  FROM jsonb_array_elements(p_values) item
  JOIN public.trades trade ON trade.id = (item->>'tradeId')::uuid AND trade.league_id = p_league_id AND trade.league_season_id = p_season_id
  WHERE jsonb_typeof(item->'revaluation') = 'object'
  ON CONFLICT (trade_id) DO UPDATE SET revaluation = EXCLUDED.revaluation, valid_until = EXCLUDED.valid_until,
    version = EXCLUDED.version, refreshed_at = now() WHERE cached.version < EXCLUDED.version;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_dispatch_screen_views()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  ORDER BY season.id ON CONFLICT DO NOTHING;
  UPDATE private.screen_refresh_queue queued SET version = version + 1, dirty = true, available_at = now(), changed_at = now()
  WHERE NOT queued.dirty AND EXISTS (
    SELECT 1 FROM public.trade_value_cache cached WHERE cached.league_season_id = queued.league_season_id AND cached.valid_until <= now());
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
    AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')) THEN
    PERFORM public.invoke_edge_function('refresh-views');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 5), 1), 10)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token, 'trades', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tradeId', trade.id, 'memberId', member.id, 'userId', member.user_id) ORDER BY trade.id)
        FROM public.trades trade JOIN public.league_members member ON member.id = trade.proposer_member_id
        WHERE trade.league_season_id = c.league_season_id), '[]'::jsonb))), '[]'::jsonb) INTO result FROM claimed c;
    RETURN result;
  END IF;
  SELECT * INTO queued FROM private.screen_refresh_queue WHERE league_id = p_league_id
    AND league_season_id = (p_params->>'seasonId')::uuid FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS NULL OR queued.claim_token IS DISTINCT FROM (p_params->>'claimToken')::uuid
    OR queued.claimed_version IS DISTINCT FROM (p_params->>'version')::bigint THEN RETURN 'false'; END IF;
  IF p_params->>'operation' = 'fail' THEN
    UPDATE private.screen_refresh_queue SET claim_token = NULL, claimed_at = NULL, claimed_version = NULL,
      available_at = now() + interval '1 minute', last_error = left(p_params->>'error', 1000) WHERE league_season_id = queued.league_season_id;
    RETURN 'true';
  END IF;
  IF p_params->>'operation' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'Unknown refresh operation.' USING ERRCODE = '22023'; END IF;
  completed := queued.version = queued.claimed_version;
  IF completed THEN
    IF EXISTS (SELECT 1 FROM public.trades trade WHERE trade.league_season_id = queued.league_season_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_params->'tradeValues', '[]')) value
        WHERE value->>'tradeId' = trade.id::text AND jsonb_typeof(value->'revaluation') = 'object')) THEN
      RAISE EXCEPTION 'A complete trade valuation set is required.' USING ERRCODE = '22023';
    END IF;
    PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_trade_values(queued.league_id, queued.league_season_id, queued.version, COALESCE(p_params->'tradeValues', '[]'));
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;

REVOKE ALL ON FUNCTION private.refresh_queue_screen_views(uuid), private.refresh_changed_screen_views(),
  private.refresh_standings(uuid,uuid,bigint), private.refresh_matchup_totals(uuid,uuid,bigint),
  private.refresh_player_averages(uuid,uuid,bigint), private.refresh_trade_values(uuid,uuid,bigint,jsonb),
  private.refresh_dispatch_screen_views(), public.view_refresh_work(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.view_refresh_work(uuid,uuid,jsonb) TO service_role;

CREATE TRIGGER refresh_views_from_hints AFTER INSERT OR UPDATE ON public.league_change_hints FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_matchups AFTER INSERT OR UPDATE OR DELETE ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_rosters AFTER INSERT OR UPDATE OR DELETE ON public.roster_players FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_settings AFTER UPDATE ON public.leagues FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_members AFTER INSERT OR UPDATE OR DELETE ON public.league_members FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_seasons AFTER INSERT OR UPDATE ON public.league_seasons FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_trades AFTER INSERT OR UPDATE OR DELETE ON public.trades FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_templates AFTER INSERT OR UPDATE OR DELETE ON public.lineup_slot_templates FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();
CREATE TRIGGER refresh_views_from_optimizer AFTER INSERT OR UPDATE OR DELETE ON public.lineup_optimizer_settings FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_screen_views();

SELECT private.refresh_queue_screen_views();
SELECT cron.schedule('refresh-views', '* * * * *', 'SELECT private.refresh_dispatch_screen_views()');

DO $bootstrap$
DECLARE job record;
BEGIN
  FOR job IN SELECT * FROM private.screen_refresh_queue ORDER BY league_season_id LOOP
    PERFORM private.refresh_standings(job.league_id, job.league_season_id, job.version);
    PERFORM private.refresh_matchup_totals(job.league_id, job.league_season_id, job.version);
    PERFORM private.refresh_player_averages(job.league_id, job.league_season_id, job.version);
  END LOOP;
END;
$bootstrap$;
