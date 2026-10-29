BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.retain_work_items(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM private.work_items r WHERE (r.status='succeeded' AND r.completed_at<p_now-interval '7 days')
      OR (r.status='dead' AND r.completed_at<p_now-interval '90 days')
    ORDER BY r.completed_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.work_items r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.work_items',v_count);
END;
$$;

UPDATE private.retention_rules SET retention_rule='Succeeded work: 7 days; dead work: 90 days; active work stays; 5000 rows per batch' WHERE relation_name='private.work_items';
COMMIT;
