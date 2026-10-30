-- Canonical SQL source for public.get_scheduler_health.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_scheduler_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' AS $$
  SELECT jsonb_build_object('level',scheduler_level,'paused',paused,'changed_at',scheduler_changed_at,
    'checked_at',scheduler_checked_at,'healthy_since',scheduler_healthy_since,
    'last_reduced_dispatch_at',scheduler_last_dispatch_at,'health',scheduler_health,
    'hint',(SELECT to_jsonb(hint)-'id' FROM public.scheduler_health_hint hint WHERE id))
  FROM private.worker_controls WHERE id
$$;
