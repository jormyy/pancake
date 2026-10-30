BEGIN;
SET LOCAL request.headers='';
DELETE FROM private.player_stats_hint_pending;
CREATE OR REPLACE FUNCTION pg_temp.hint_reference()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT pending.league_id FROM private.player_stats_hint_pending pending
    WHERE NOT EXISTS(SELECT 1 FROM public.league_change_hints hint
      WHERE hint.league_id=pending.league_id AND hint.topic='score'
        AND hint.updated_at>clock_timestamp()-interval '1 minute')
    ORDER BY pending.league_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), emitted AS (
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details,updated_at)
    SELECT ready.league_id,'score',1,NULL,NULL,clock_timestamp() FROM ready
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=NULL,updated_at=clock_timestamp()
    WHERE stored.updated_at<=clock_timestamp()-interval '1 minute'
    RETURNING league_id
  ) DELETE FROM private.player_stats_hint_pending WHERE league_id IN (SELECT league_id FROM emitted);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE FUNCTION pg_temp.hint_outcome(p_reference boolean) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_reference THEN RETURN pg_temp.hint_reference()::text; END IF;
  RETURN private.flush_player_stats_hints()::text;
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END;
$$;
DO $$
DECLARE header text; expected text; actual text; invocation uuid:='fabe1700-0000-4000-8000-000000000099';
BEGIN
  FOREACH header IN ARRAY ARRAY['','{}','{"unrelated":"value"}',
    '{"x-pancake-work-key":"fabe1700-0000-4000-8000-000000000099"}','invalid-json'] LOOP
    PERFORM set_config('request.headers',header,true);
    expected:=pg_temp.hint_outcome(true);
    actual:=pg_temp.hint_outcome(false);
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Hint fence parity failed: expected %, got %',expected,actual; END IF;
  END LOOP;
  PERFORM set_config('request.headers','',true);
  INSERT INTO private.work_items(kind,key,status,attempts,lease_token,lease_until,invocation_key)
    VALUES('live-poll','pipeline-hint-lease','running',1,gen_random_uuid(),clock_timestamp()+interval '5 minutes',invocation);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-work-key',invocation)::text,true);
  IF pg_temp.hint_outcome(true)<>'0' OR pg_temp.hint_outcome(false)<>'0' THEN RAISE EXCEPTION 'Current lease rejected'; END IF;
  UPDATE private.work_items SET lease_until=clock_timestamp()-interval '1 minute' WHERE invocation_key=invocation;
  IF pg_temp.hint_outcome(true)<>'PT409' OR pg_temp.hint_outcome(false)<>'PT409' THEN RAISE EXCEPTION 'Expired lease admitted'; END IF;
END;
$$;
ROLLBACK;
