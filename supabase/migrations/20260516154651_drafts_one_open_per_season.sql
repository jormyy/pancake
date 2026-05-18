-- Enforce "at most one open draft per (league, season, draft_type)" at the DB.
--
-- Finding (iter 24, slice B):
-- - backend/src/sync/draft.ts `startDraft` (auction) and
--   backend/src/sync/rookieDraft.ts `startRookieDraft` (snake) both do a
--   check-then-insert sequence:
--     1. SELECT league_seasons (current)
--     2. SELECT drafts ... .in('status', ['pending','in_progress']).maybeSingle()
--     3. INSERT drafts(...)
--   None of these reads take a row lock and the functions are plain JS, so a
--   commissioner double-tap (or two concurrent commissioners) can both observe
--   "no open draft" in step 2 and both INSERT in step 3. The result is two
--   simultaneously-open drafts for the same (league, season, draft_type),
--   which breaks downstream invariants (auction nomination ordering, snake
--   pick clocks, leagues.status flips, etc.).
-- - The cheapest fix mirrors iter 22 slice B (nominations_one_open_per_draft):
--   a partial UNIQUE index on the open-status tuple lets Postgres reject the
--   second INSERT atomically with SQLSTATE 23505. The TS layer translates that
--   23505 back to the existing user-facing error message so callers don't see
--   a raw Postgres error.
--
-- The index is partial on status IN ('pending','in_progress') because
-- 'completed', 'cancelled', and 'paused' rows are the historical record of
-- every previous draft for the league season and must not block a new one.
-- (A new draft cannot legitimately start while one is 'paused' either, but
-- paused is intentionally excluded here so an operator can intervene on the
-- paused row before the constraint blocks them; the existing TS check uses
-- ['pending','in_progress'] and this index matches it exactly.)
--
-- Including draft_type in the index lets a league legitimately have both an
-- auction draft (initial) and a snake draft (rookie) open in different
-- seasons (or, in the unlikely future case, distinct types in the same
-- season). The current TS callers all key off (league_id, league_season_id,
-- draft_type) so this matches their intent.
--
-- CREATE INDEX IF NOT EXISTS is idempotent for re-runs.

CREATE UNIQUE INDEX IF NOT EXISTS drafts_one_open_per_season
  ON public.drafts (league_id, league_season_id, draft_type)
  WHERE status IN ('pending', 'in_progress');
