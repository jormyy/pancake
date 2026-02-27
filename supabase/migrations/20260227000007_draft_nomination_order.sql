-- Track which nomination slot is currently up in a rotation-based auction draft.
-- current_nomination_order starts at 1 and increments after each nomination closes.
-- The current nominator = draft_orders.member_id WHERE position = ((current_nomination_order - 1) % N) + 1

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS current_nomination_order int NOT NULL DEFAULT 1;
