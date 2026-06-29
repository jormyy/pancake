-- Superseded marker.
--
-- This version originally carried broad RPC redefinitions solely to quiet DB
-- lint output. Those snapshots made the Edge cutover hard to review and were
-- removed; focused domain migrations own durable behavior changes.

DO $$
BEGIN
  NULL;
END;
$$;
