BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE OR REPLACE FUNCTION private.trade_revaluation_input_versions(p_league_id uuid)
RETURNS TABLE(trade_id uuid,input_version text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH context AS MATERIALIZED (
    SELECT league.id AS league_id,season.id AS season_id,season.season_year,league.roster_size,league.scoring_settings,
      league.faab_starting_budget,league.future_pick_years,(SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams,
      queued.averages_initialized
    FROM public.leagues league JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id
    WHERE league.id=p_league_id AND league.deleted_at IS NULL
  ), versions AS MATERIALIZED (
    SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) AS value FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions,context
      WHERE scope IN ('',context.league_id::text,context.season_id::text) GROUP BY source,scope) source
  ), temporal AS MATERIALIZED (
    SELECT jsonb_build_array((now() AT TIME ZONE 'America/New_York')::date,
      (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<=now()),
      (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<now()-interval '90 days'),
      (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<=now()),
      (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '36 hours'),
      (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '8 days'),
      (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<=now()),
      (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<now()-interval '36 hours'),
      (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<=now()),
      (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<now()-interval '8 days'),
      (SELECT max(game_time) FROM public.nba_games WHERE game_time<=now()),
      (SELECT max(started_at) FROM public.nba_games WHERE started_at<=now())) AS value
  ), open_trades AS MATERIALIZED (
    SELECT trade.id FROM public.trades trade WHERE trade.league_id=p_league_id AND trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item JOIN open_trades trade ON trade.id=item.trade_id
  ), asset_values AS (
    SELECT trade_id,jsonb_agg(jsonb_build_array(from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY id) AS value
    FROM assets GROUP BY trade_id
  ), pick_values AS (
    SELECT asset.trade_id,jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id) AS value
    FROM (SELECT DISTINCT trade_id,pick_id FROM assets WHERE pick_id IS NOT NULL) asset
    JOIN public.draft_picks pick ON pick.id=asset.pick_id JOIN public.league_members member ON member.id=pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id GROUP BY asset.trade_id
  ), balance_values AS (
    SELECT asset.trade_id,jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id) AS value
    FROM (SELECT DISTINCT trade_id,from_member_id FROM assets) asset CROSS JOIN context
    JOIN public.league_members member ON member.id=asset.from_member_id AND member.league_id=context.league_id
    LEFT JOIN public.faab_balances balance ON balance.member_id=member.id AND balance.league_season_id=context.season_id
    GROUP BY asset.trade_id
  )
  SELECT trade.id,md5((jsonb_build_array('trade-inputs-v2',to_jsonb(context)||jsonb_build_object('id',trade.id),
    versions.value,asset.value,pick.value,balance.value)||temporal.value)::text)
  FROM open_trades trade CROSS JOIN context CROSS JOIN versions CROSS JOIN temporal
  LEFT JOIN asset_values asset ON asset.trade_id=trade.id LEFT JOIN pick_values pick ON pick.trade_id=trade.id
  LEFT JOIN balance_values balance ON balance.trade_id=trade.id;
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_input_versions(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluations(p_season_id uuid,p_version bigint,p_model text,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued integer:=0; selected_league uuid;
BEGIN
  PERFORM private.compact_trade_input_revisions();
  SELECT league_id INTO selected_league FROM public.league_seasons WHERE id=p_season_id;
  SELECT count(*) FILTER (WHERE private.refresh_queue_trade_revaluation(input.trade_id,input.input_version,p_model))
    INTO queued FROM private.trade_revaluation_input_versions(selected_league) input
    JOIN public.trades trade ON trade.id=input.trade_id
    WHERE trade.league_season_id=p_season_id AND (p_after IS NULL OR trade.id>p_after);
  RETURN jsonb_build_object('queued',queued);
END;
$$;
CREATE OR REPLACE FUNCTION private.coalesce_trade_revaluation_work()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_ids bigint[]; target record; scan_id bigint; scan_payload jsonb; batch_id bigint;
  replaced integer:=0; affected integer; scans integer:=0;
BEGIN
  SELECT array_agg(id) INTO selected_ids FROM (
    SELECT id FROM private.work_items WHERE kind IN ('trade-revaluation-check','trade-revaluation-scan')
      AND status='pending' ORDER BY id FOR UPDATE SKIP LOCKED
  ) locked;
  FOR target IN
    SELECT season.id AS season_id,season.league_id,
      GREATEST(COALESCE(max(queued.version),0),COALESCE(max(CASE WHEN item.payload->>'version' ~ '^[0-9]{1,18}$'
        THEN (item.payload->>'version')::bigint END),0)) AS version,
      min(item.due_at) AS due_at,array_agg(item.id ORDER BY item.id) AS ids
    FROM private.work_items item
    LEFT JOIN public.trades trade ON item.kind='trade-revaluation-check' AND trade.id::text=item.payload->>'tradeId'
    LEFT JOIN public.league_seasons season ON season.id::text=CASE WHEN item.kind='trade-revaluation-check'
      THEN trade.league_season_id::text ELSE item.payload->>'seasonId' END
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id
    WHERE item.id=ANY(selected_ids) GROUP BY season.id,season.league_id
  LOOP
    scan_id:=NULL;
    IF EXISTS(SELECT 1 FROM public.trades trade JOIN public.leagues league ON league.id=trade.league_id
      WHERE trade.league_season_id=target.season_id AND trade.status IN ('pending','accepted') AND league.deleted_at IS NULL) THEN
      SELECT id,payload INTO scan_id,scan_payload FROM private.work_items
        WHERE id=ANY(target.ids) AND kind='trade-revaluation-scan' ORDER BY due_at,id LIMIT 1;
      batch_id:=COALESCE((scan_payload->>'upgradeBatch')::bigint,target.ids[1]);
      scan_payload:=jsonb_build_object('revaluationScan',true,'leagueId',target.league_id,'seasonId',target.season_id,
        'version',target.version);
      IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan' AND status='running' AND payload=scan_payload) THEN
        scan_payload:=scan_payload||jsonb_build_object('upgradeBatch',batch_id);
      END IF;
      UPDATE private.work_items SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL,
        payload=payload||jsonb_build_object('supersededBy','league-wide scan')
        WHERE id=ANY(target.ids) AND id IS DISTINCT FROM scan_id;
      GET DIAGNOSTICS affected=ROW_COUNT;
      replaced:=replaced+affected;
      IF scan_id IS NULL THEN
        INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
          VALUES('trade-revaluation-scan',target.season_id::text||':upgrade:'||batch_id::text,target.due_at,scan_payload,target.league_id)
          RETURNING id INTO scan_id;
      ELSE
        UPDATE private.work_items SET due_at=target.due_at,payload=scan_payload,league_id=target.league_id,completed_at=NULL,
          lease_token=NULL,lease_until=NULL
          WHERE id=scan_id AND (due_at IS DISTINCT FROM target.due_at
            OR payload IS DISTINCT FROM scan_payload OR league_id IS DISTINCT FROM target.league_id);
      END IF;
      scans:=scans+1;
    ELSE
      UPDATE private.work_items SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL,
        payload=payload||jsonb_build_object('supersededBy','no open trades')
        WHERE id=ANY(target.ids);
      GET DIAGNOSTICS affected=ROW_COUNT;
      replaced:=replaced+affected;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('superseded',replaced,'scans',scans);
END;
$$;
REVOKE ALL ON FUNCTION private.coalesce_trade_revaluation_work() FROM PUBLIC,anon,authenticated,service_role;

SELECT private.coalesce_trade_revaluation_work();
COMMIT;
