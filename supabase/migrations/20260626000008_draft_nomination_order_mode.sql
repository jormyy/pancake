-- Startup auction draft nomination-order modes (locked decision):
--   user_nominated  — managers freely search & nominate any player (default)
--   by_projection   — nomination board ordered by dynasty/projection rank
--   alphabetical    — nomination board ordered A→Z
-- Rookie (snake) drafts ignore this and keep pick-ownership order.

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS nomination_order_mode text NOT NULL DEFAULT 'user_nominated';

ALTER TABLE public.drafts
  DROP CONSTRAINT IF EXISTS drafts_nomination_order_mode_check;

ALTER TABLE public.drafts
  ADD CONSTRAINT drafts_nomination_order_mode_check
  CHECK (nomination_order_mode IN ('user_nominated', 'by_projection', 'alphabetical'));

COMMENT ON COLUMN public.drafts.nomination_order_mode IS
  'Startup auction nomination board ordering: user_nominated (free), by_projection (dynasty/projection order), or alphabetical. Rookie/snake drafts ignore this.';
