ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS timer_paused_remaining_seconds int;

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_timer_paused_remaining_nonnegative;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_timer_paused_remaining_nonnegative
  CHECK (timer_paused_remaining_seconds IS NULL OR timer_paused_remaining_seconds >= 0);

CREATE TABLE IF NOT EXISTS public.draft_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  actor_user_id uuid,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_audit_logs_action_not_blank CHECK (length(trim(action)) > 0),
  CONSTRAINT draft_audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_draft_audit_logs_draft_created
  ON public.draft_audit_logs (draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_draft_audit_logs_league_created
  ON public.draft_audit_logs (league_id, created_at DESC);

ALTER TABLE public.draft_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS draft_audit_logs_select_league_members ON public.draft_audit_logs;
CREATE POLICY draft_audit_logs_select_league_members ON public.draft_audit_logs
  FOR SELECT TO authenticated
  USING ((SELECT private.is_league_member(league_id)));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.draft_audit_logs FROM anon, authenticated;
GRANT SELECT ON public.draft_audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.draft_audit_logs TO service_role;

DROP FUNCTION IF EXISTS public.stop_draft_atomic(uuid);
DROP FUNCTION IF EXISTS public.reset_draft_atomic(uuid);
DROP FUNCTION IF EXISTS public.pause_draft_atomic(uuid);
DROP FUNCTION IF EXISTS public.resume_draft_atomic(uuid);
