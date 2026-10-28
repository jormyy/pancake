CREATE OR REPLACE FUNCTION public.claim_trade_value_sync(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.trade_value_sync_state SET request_id=p_request_id,last_request_at=clock_timestamp()
  WHERE id
    AND (fetched_at IS NULL OR (fetched_at AT TIME ZONE 'America/New_York')::date<(clock_timestamp() AT TIME ZONE 'America/New_York')::date)
    AND (request_id IS NULL OR last_request_at IS NULL OR last_request_at<clock_timestamp()-interval '3 minutes');
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_trade_value_sync(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trade_value_sync(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_trade_value_sync(p_request_id uuid,p_retry integer DEFAULT 0,p_retry_date date DEFAULT NULL,p_schedule_retry boolean DEFAULT true)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_date date; v_id bigint;
  v_invocation text:=nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-pancake-work-key','');
BEGIN
  IF p_retry IS NULL OR p_retry NOT BETWEEN 0 AND 4 THEN
    RAISE EXCEPTION 'Retry must be an integer from zero through four.' USING ERRCODE='22023';
  END IF;
  UPDATE private.trade_value_sync_state SET request_id=NULL
    WHERE id AND request_id=p_request_id
      AND (fetched_at IS NULL OR fetched_at<last_request_at)
    RETURNING (last_request_at AT TIME ZONE 'America/New_York')::date INTO v_date;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT coalesce(p_schedule_retry,false) THEN RETURN NULL; END IF;
  UPDATE private.work_items SET attempts=greatest(attempts,3)
    WHERE kind='sync-trade-values' AND invocation_key=v_invocation::uuid
      AND status='running' AND lease_until>clock_timestamp();
  IF p_retry=4 OR (p_retry_date IS NOT NULL AND p_retry_date<>v_date) THEN RETURN NULL; END IF;
  v_id:=private.work_enqueue('sync-trade-values','sync-trade-values-retry-'||(p_retry+1)||'-'||v_date,
    clock_timestamp()+interval '30 minutes',jsonb_build_object('retry',p_retry+1,'retryDate',v_date));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_trade_value_sync(uuid,integer,date,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fail_trade_value_sync(uuid,integer,date,boolean) TO service_role;
