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
