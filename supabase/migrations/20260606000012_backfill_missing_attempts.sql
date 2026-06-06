ALTER TABLE public.backfill_game_attempts
  DROP CONSTRAINT IF EXISTS backfill_game_attempts_status_check;

ALTER TABLE public.backfill_game_attempts
  ADD CONSTRAINT backfill_game_attempts_status_check
  CHECK (status IN ('completed', 'failed', 'missing'));
