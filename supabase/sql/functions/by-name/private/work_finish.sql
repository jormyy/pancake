-- Canonical SQL source for private.work_finish.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.work_finish(p_id bigint, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item private.work_items%ROWTYPE;
BEGIN
  UPDATE private.work_items SET
    status=CASE WHEN p_error IS NULL THEN 'succeeded' WHEN attempts>=3 THEN 'dead' ELSE 'failed' END,
    due_at=CASE WHEN p_error IS NULL THEN due_at ELSE now()+make_interval(secs=>least(900,60*power(2,greatest(attempts-1,0))::int)) END,
    completed_at=CASE WHEN p_error IS NULL OR attempts>=3 THEN now() END,
    last_error=left(p_error,4000),lease_until=NULL,lease_token=NULL
  WHERE id=p_id AND status='running' AND lease_token=p_token AND lease_until>now()
  RETURNING * INTO v_item;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_item.status IN ('succeeded','dead') THEN
    INSERT INTO public.league_events(league_id,kind,summary,detail)
    VALUES(v_item.league_id,'work.'||v_item.status,
      v_item.kind||CASE WHEN p_error IS NULL THEN ' completed' ELSE ' failed after three attempts' END,
      jsonb_build_object('work_id',v_item.id,'kind',v_item.kind,'key',v_item.key,'attempts',v_item.attempts,'error',p_error));
  END IF;
  RETURN true;
END;
$$;
