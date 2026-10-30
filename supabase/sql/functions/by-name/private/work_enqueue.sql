-- Canonical SQL source for private.work_enqueue.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.work_enqueue(p_kind text, p_key text, p_due_at timestamptz DEFAULT now(), p_payload jsonb DEFAULT '{}'::jsonb, p_league_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id bigint;
BEGIN
  IF EXISTS(SELECT 1 FROM private.work_kinds WHERE kind=p_kind AND retired_at IS NOT NULL) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind=p_kind AND key=p_key) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM private.work_items
    WHERE kind=p_kind AND status IN ('pending','running','failed')
      AND (CASE WHEN kind='pre-tipoff' THEN payload->>'tipoffAt' ELSE md5(payload::text) END)
        =(CASE WHEN p_kind='pre-tipoff' THEN p_payload->>'tipoffAt' ELSE md5(p_payload::text) END)
  ) THEN RETURN NULL; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
  VALUES(p_kind,p_key,p_due_at,p_payload,p_league_id)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
