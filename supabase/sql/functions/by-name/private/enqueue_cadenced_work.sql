-- Canonical SQL source for private.enqueue_cadenced_work.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_cadenced_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind record; v_local timestamp; v_period timestamp;
BEGIN
  FOR v_kind IN SELECT kind,cadence,due_offset,cadence_zone,schedule_payload FROM private.work_kinds
    WHERE cadence IS NOT NULL AND retired_at IS NULL ORDER BY kind LOOP
    v_local:=p_now AT TIME ZONE v_kind.cadence_zone;
    v_period:=date_bin(v_kind.cadence,v_local,timestamp '2000-01-03 00:00');
    IF v_local>=v_period+v_kind.due_offset THEN
      PERFORM private.work_enqueue(v_kind.kind,
        CASE WHEN v_kind.cadence>=interval '1 day' THEN v_period::date::text ELSE v_period::text END,
        p_now,v_kind.schedule_payload);
    END IF;
  END LOOP;
END;
$$;
