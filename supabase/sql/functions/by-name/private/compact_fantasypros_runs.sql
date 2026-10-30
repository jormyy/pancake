-- Canonical SQL source for private.compact_fantasypros_runs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.compact_fantasypros_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_ids uuid[];
BEGIN
  IF NEW.source<>'fantasypros' OR NEW.status<>'success' OR NEW.completed_at IS NULL
    OR OLD.status='success' AND OLD.completed_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM public.projection_sync_runs r WHERE r.source='fantasypros'
      AND r.projection_type=NEW.projection_type AND r.status='success' AND r.completed_at IS NOT NULL
      AND (r.started_at,r.id)<(NEW.started_at,NEW.id)
      AND (NEW.projection_type='daily' AND r.projection_date=NEW.projection_date
        OR NEW.projection_type<>'daily' AND r.season_year=NEW.season_year AND r.week_number=NEW.week_number)
    ORDER BY r.started_at LIMIT 200
  ) old_runs;
  PERFORM private.delete_projection_runs(v_ids,100000);
  RETURN NULL;
END;
$$;
