ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS timer_expiry_behavior text NOT NULL DEFAULT 'auto_pick',
  ADD COLUMN IF NOT EXISTS pause_reason text;

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_timer_expiry_behavior_known;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_timer_expiry_behavior_known CHECK (
    timer_expiry_behavior IN (
      'auto_pick',
      'skip_pick',
      'pause_draft',
      'commissioner_pick',
      'auction_no_bid'
    )
  );

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_pause_reason_known;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_pause_reason_known CHECK (
    pause_reason IS NULL OR pause_reason IN (
      'manual',
      'timer_expired_pause',
      'timer_expired_commissioner_pick'
    )
  );

UPDATE public.drafts
   SET timer_expiry_behavior = 'auction_no_bid'
 WHERE draft_type = 'auction'
   AND timer_expiry_behavior = 'auto_pick';

ALTER TABLE public.snake_draft_picks
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS skip_reason text;

DROP INDEX IF EXISTS public.idx_snake_draft_picks_expiring_timer;

CREATE INDEX IF NOT EXISTS idx_snake_draft_picks_active_timer
  ON public.snake_draft_picks (timer_expires_at, overall_pick)
  WHERE player_id IS NULL AND skipped_at IS NULL AND timer_expires_at IS NOT NULL;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.arm_next_snake_pick_timer(
  p_draft_id uuid,
  p_expires_at timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timer_expires_at timestamptz;
BEGIN
  UPDATE snake_draft_picks
     SET timer_expires_at = p_expires_at
   WHERE id = (
     SELECT id
       FROM snake_draft_picks
      WHERE draft_id = p_draft_id
        AND player_id IS NULL
        AND skipped_at IS NULL
      ORDER BY overall_pick
      LIMIT 1
   )
   RETURNING timer_expires_at INTO v_timer_expires_at;

  RETURN v_timer_expires_at;
END;
$$;

DROP INDEX IF EXISTS public.drafts_one_open_per_season;
CREATE UNIQUE INDEX drafts_one_open_per_season
  ON public.drafts (league_id, league_season_id, draft_type)
  WHERE status IN ('pending', 'in_progress', 'paused') AND is_mock = false;
