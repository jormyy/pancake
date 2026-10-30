-- Canonical SQL source for private.dispatch_live_matchup_refresh.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.dispatch_live_matchup_refresh()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE revision bigint; item private.work_items%ROWTYPE;
BEGIN
  SELECT queued.revision INTO revision FROM private.live_matchup_refresh_queue queued ORDER BY queued.revision LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM private.work_enqueue('refresh-live-matchups',revision::text,now());
  WITH due AS (
    SELECT id FROM private.work_items WHERE kind='refresh-live-matchups' AND status IN('pending','failed') AND due_at<=now()
    ORDER BY due_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE private.work_items stored SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+interval '5 minutes',invocation_key=NULL
    FROM due WHERE stored.id=due.id RETURNING stored.* INTO item;
  IF NOT FOUND THEN RETURN 0; END IF;
  BEGIN
    PERFORM private.work_execute(item.id,item.lease_token);
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.work_finish(item.id,item.lease_token,SQLERRM);
  END;
  RETURN 1;
END;
$$;
