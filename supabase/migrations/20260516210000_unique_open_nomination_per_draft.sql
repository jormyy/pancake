-- Enforce "at most one open nomination per draft" at the database level.
--
-- Finding (iter 22, slice B):
-- - backend/src/sync/draft.ts `nominatePlayer` performs three sequential reads
--   before INSERTing a new nomination:
--     1. SELECT draft (status check)
--     2. SELECT existing open nomination via maybeSingle()  ← race window
--     3. SELECT existing nomination for this player_id     ← race window
--     4. INSERT new open nomination
--   None of those reads take a row lock and the function is plain JS, so two
--   concurrent submits from the same nominator with DIFFERENT player_ids can
--   both observe "no open nomination" in step 2 and both INSERT in step 4.
--   Result: two simultaneously-open nominations in the same draft, which
--   breaks the rest of the bidding flow (place_auction_bid_atomic and the
--   countdown cron both assume at most one open row per draft).
-- - The existing UNIQUE (draft_id, player_id) constraint on nominations
--   catches identical re-submits but NOT different-player races.
-- - Heavier alternatives (a new nominate_player_atomic RPC, pg_advisory_xact_lock
--   on draft_id) require more code churn; a partial UNIQUE index lets Postgres
--   enforce the invariant atomically with no RPC needed. The conflicting
--   INSERT fails with SQLSTATE 23505, which the TS layer translates back to
--   the existing user-facing "A nomination is already open" error.
--
-- The index is partial on status='open' because 'sold' and 'no_bid' rows are
-- the historical record of every previous nomination in the draft — they
-- legitimately accumulate as the draft progresses and must not block new
-- nominations. Only the live nomination is unique.
--
-- CREATE INDEX IF NOT EXISTS is idempotent for re-runs against an environment
-- that has already applied the migration.

CREATE UNIQUE INDEX IF NOT EXISTS nominations_one_open_per_draft
  ON public.nominations (draft_id)
  WHERE status = 'open';
