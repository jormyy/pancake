BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE private.trade_revaluation_scans(
  league_season_id uuid PRIMARY KEY REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  model_version text NOT NULL,
  next_change_at timestamptz NOT NULL,
  fingerprints jsonb NOT NULL
);
ALTER TABLE private.trade_revaluation_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.trade_revaluation_scans FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION private.trade_revaluation_source_version(p_season_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH context AS MATERIALIZED (
    SELECT current_season.id,season.league_id,current_season.season_year,league.roster_size,league.scoring_settings,
      league.faab_starting_budget,league.future_pick_years,queued.averages_initialized,
      (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams
    FROM public.league_seasons season JOIN public.leagues league ON league.id=season.league_id AND league.deleted_at IS NULL
    JOIN public.league_seasons current_season ON current_season.league_id=league.id AND current_season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=current_season.id
    WHERE season.id=p_season_id
  ), open_trades AS MATERIALIZED (
    SELECT trade.id FROM public.trades trade JOIN context ON context.league_id=trade.league_id WHERE trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item JOIN open_trades trade ON trade.id=item.trade_id
  )
  SELECT md5(jsonb_build_array('trade-scan-v2',to_jsonb(context),
    (now() AT TIME ZONE 'America/New_York')::date,
    (SELECT jsonb_agg(id ORDER BY id) FROM open_trades),
    (SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions WHERE scope IN ('',context.league_id::text,context.id::text)
      GROUP BY source,scope) versions),
    (SELECT jsonb_agg(jsonb_build_array(trade_id,id,from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY trade_id,id) FROM assets),
    (SELECT jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
      LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
      WHERE pick.id IN(SELECT pick_id FROM assets)),
    (SELECT jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id)
      FROM public.league_members member LEFT JOIN public.faab_balances balance
        ON balance.member_id=member.id AND balance.league_season_id=context.id
      WHERE member.league_id=context.league_id AND member.id IN(SELECT from_member_id FROM assets))
  )::text) FROM context WHERE EXISTS(SELECT 1 FROM open_trades);
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_source_version(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.trade_revaluation_next_change()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT LEAST(((now() AT TIME ZONE 'America/New_York')::date+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(fetched_at) FROM public.dynasty_rankings WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '90 days 1 microsecond' FROM public.dynasty_rankings WHERE fetched_at>=now()-interval '90 days'),
    (SELECT min(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '36 hours 1 microsecond' FROM public.fantasypros_projection_rows WHERE fetched_at>=now()-interval '36 hours'),
    (SELECT min(fetched_at)+interval '8 days 1 microsecond' FROM public.fantasypros_projection_rows WHERE fetched_at>=now()-interval '8 days'),
    (SELECT min(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '36 hours 1 microsecond' FROM public.sleeper_projection_rows WHERE fetched_at>=now()-interval '36 hours'),
    (SELECT min(fetched_at) FROM public.player_projections WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '8 days 1 microsecond' FROM public.player_projections WHERE fetched_at>=now()-interval '8 days'),
    (SELECT min(game_time) FROM public.nba_games WHERE game_time>now()),
    (SELECT min(started_at) FROM public.nba_games WHERE started_at>now()));
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_next_change() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluations(p_season_id uuid,p_version bigint,p_model text,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued integer:=0; selected_league uuid; source_version text; fingerprints jsonb;
BEGIN
  PERFORM private.compact_trade_input_revisions();
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  WITH inputs AS MATERIALIZED (
    SELECT input.* FROM private.trade_revaluation_input_versions(selected_league) input JOIN public.trades trade ON trade.id=input.trade_id
    WHERE trade.league_season_id=p_season_id
  )
  SELECT count(*) FILTER (WHERE (p_after IS NULL OR input.trade_id>p_after)
      AND private.refresh_queue_trade_revaluation(input.trade_id,input.input_version,p_model)),
    COALESCE(jsonb_object_agg(input.trade_id,input.input_version),'{}'),private.trade_revaluation_source_version(p_season_id)
    INTO queued,fingerprints,source_version FROM inputs input;
  IF source_version IS NOT NULL AND p_model IS NOT NULL THEN
    INSERT INTO private.trade_revaluation_scans AS stored(league_season_id,source_version,model_version,next_change_at,fingerprints)
      VALUES(p_season_id,source_version,p_model,private.trade_revaluation_next_change(),fingerprints)
    ON CONFLICT(league_season_id) DO UPDATE SET source_version=EXCLUDED.source_version,model_version=EXCLUDED.model_version,
      next_change_at=EXCLUDED.next_change_at,fingerprints=EXCLUDED.fingerprints;
  ELSE
    DELETE FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
  END IF;
  RETURN jsonb_build_object('queued',queued);
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_trade_revaluation_scan(p_season_id uuid,p_version bigint,p_model text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_league uuid; source_version text; previous private.trade_revaluation_scans%ROWTYPE;
BEGIN
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  IF NOT EXISTS(SELECT 1 FROM public.trades WHERE league_season_id=p_season_id AND status IN ('pending','accepted')) THEN
    DELETE FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    RETURN false;
  END IF;
  IF p_model IS NOT NULL THEN
    source_version:=private.trade_revaluation_source_version(p_season_id);
    SELECT * INTO previous FROM private.trade_revaluation_scans WHERE league_season_id=p_season_id;
    IF previous.source_version=source_version AND previous.model_version=p_model AND previous.next_change_at>now()
      AND NOT EXISTS(
        SELECT 1 FROM jsonb_each_text(previous.fingerprints) input
        WHERE NOT EXISTS(SELECT 1 FROM private.trade_value_publications published WHERE published.trade_id=input.key::uuid
          AND published.input_fingerprint=input.value AND published.model_version=p_model)
        AND NOT EXISTS(SELECT 1 FROM private.work_items work WHERE work.kind='trade-revaluation'
          AND work.key=input.key||':'||p_model||':latest' AND work.status IN ('pending','running','failed')
          AND work.payload->>'inputFingerprint'=input.value)
      ) THEN
      UPDATE private.trade_value_publications published SET version=queued.version,valid_until='infinity'
      FROM jsonb_each_text(previous.fingerprints) input JOIN public.trades trade ON trade.id=input.key::uuid
        JOIN private.screen_refresh_queue queued ON queued.league_season_id=trade.league_season_id
      WHERE published.trade_id=trade.id AND published.input_fingerprint=input.value
        AND published.model_version=p_model AND published.version<queued.version;
      RETURN false;
    END IF;
  END IF;
  RETURN private.work_enqueue('trade-revaluation-scan',p_season_id::text||':'||p_version::text,now(),
    jsonb_build_object('revaluationScan',true,'leagueId',selected_league,'seasonId',p_season_id,'version',p_version),selected_league) IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.enqueue_trade_revaluation_scan(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF p_params->>'operation'='begin-trade' THEN
    RETURN to_jsonb(private.begin_trade_revaluation((p_params->>'tradeId')::uuid,p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='check-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      private.trade_revaluation_input_version((p_params->>'tradeId')::uuid),p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='trade-ready' THEN
    RETURN to_jsonb(EXISTS(SELECT 1 FROM public.trades trade WHERE trade.id=(p_params->>'tradeId')::uuid
      AND trade.status IN ('pending','accepted') AND NOT EXISTS(SELECT 1 FROM private.trade_value_publications published
        WHERE published.trade_id=trade.id AND published.input_fingerprint=p_params->>'inputFingerprint'
          AND published.model_version=p_params->>'modelVersion')));
  END IF;
  IF p_params->>'operation'='queue-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      p_params->>'inputFingerprint',p_params->>'modelVersion',p_params->'inputs'));
  END IF;
  IF p_params->>'operation'='queue-trades' THEN
    RETURN private.refresh_queue_trade_revaluations((p_params->>'seasonId')::uuid,
      (p_params->>'version')::bigint,p_params->>'modelVersion',(p_params->>'after')::uuid);
  END IF;
  IF p_params->>'operation'='publish-trade' THEN
    RETURN to_jsonb(private.refresh_trade_values(p_league_id,(p_params->>'seasonId')::uuid,
      (SELECT version FROM private.screen_refresh_queue WHERE league_season_id=(p_params->>'seasonId')::uuid),
      jsonb_build_array(jsonb_build_object('tradeId',p_params->>'tradeId','revaluation',p_params->'revaluation'))));
  END IF;
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 1), 1), 1)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token)), '[]'::jsonb) INTO result FROM claimed c;
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
    PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.enqueue_trade_revaluation_scan(queued.league_season_id,queued.version,p_params->>'modelVersion');
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL, available_at = CASE WHEN completed THEN available_at ELSE now() + interval '5 seconds' END WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;
INSERT INTO private.retention_rules(relation_name,retention_rule)
  VALUES('private.trade_revaluation_scans','One scan marker per season; refreshed after scans and cascades with the season');
SELECT private.coalesce_trade_revaluation_work();
COMMIT;
