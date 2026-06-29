-- Enable RLS on matchups (missed from the original rls_policies migration).
-- Matchups are league-scoped and read-only for clients; all writes go through
-- service-role server paths that bypass RLS.

CREATE POLICY "matchups_select" ON matchups
  FOR SELECT TO authenticated
  USING (league_id IN (SELECT private.my_league_ids()));

ALTER TABLE matchups ENABLE ROW LEVEL SECURITY;
