-- Canonical SQL source for private.refresh_queue_trade_revaluation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluation(p_trade_id uuid,p_fingerprint text,p_model text,p_inputs jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; work_key text; work_payload jsonb; existing private.work_items%ROWTYPE; due timestamptz; queued_id bigint;
BEGIN
  SELECT t.*,m.user_id,q.version AS screen_version INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    JOIN private.screen_refresh_queue q ON q.league_season_id=t.league_season_id
    WHERE t.id=p_trade_id AND t.status IN ('pending','accepted');
  IF NOT FOUND OR p_fingerprint IS NULL OR p_model IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
    AND input_fingerprint=p_fingerprint AND model_version=p_model) THEN
    UPDATE private.trade_value_publications SET version=GREATEST(version,trade.screen_version),valid_until='infinity'
      WHERE trade_id=trade.id AND version<trade.screen_version;
    RETURN false;
  END IF;
  due:=now();
  IF private.trade_revaluation_is_live(trade.id) THEN
    SELECT GREATEST(now(),next_allowed_at) INTO due FROM private.trade_revaluation_schedule
      WHERE trade_id=trade.id;
    due:=COALESCE(due,now());
  END IF;
  work_key:=trade.id::text||':'||p_model||':latest';
  work_payload:=jsonb_build_object('tradeId',trade.id,'memberId',trade.proposer_member_id,'userId',trade.user_id,
    'inputFingerprint',p_fingerprint,'modelVersion',p_model,'latestInputs',true);
  SELECT * INTO existing FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    IF existing.status='running' THEN RETURN false; END IF;
    UPDATE private.work_items SET status='pending',attempts=CASE WHEN existing.status IN ('succeeded','dead') THEN 0 ELSE attempts END,
      due_at=CASE WHEN existing.status IN ('pending','failed') THEN LEAST(existing.due_at,due) ELSE due END,
      completed_at=NULL,payload=work_payload,last_error=NULL,invocation_key=NULL
      WHERE id=existing.id;
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key) THEN RETURN false; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation',work_key,due,work_payload,trade.league_id) ON CONFLICT DO NOTHING RETURNING id INTO queued_id;
  RETURN queued_id IS NOT NULL;
END;
$$;
