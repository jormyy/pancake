-- Canonical SQL source for private.enqueue_rankings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_rankings(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York'; v_view text;
BEGIN
  IF extract(isodow FROM v_local)=1 AND v_local::time<time '07:00' THEN RETURN; END IF;
  FOREACH v_view IN ARRAY ARRAY['POINT_3','ROOKIE','POINT_5'] LOOP
    PERFORM private.work_enqueue('sync-rankings',to_char(v_local,'IYYY-IW')||':'||v_view,p_now,jsonb_build_object('view',v_view));
  END LOOP;
END;
$$;
