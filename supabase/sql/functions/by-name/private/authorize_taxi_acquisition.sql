-- Canonical SQL source for private.authorize_taxi_acquisition.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.authorize_taxi_acquisition(
  p_league_id uuid, p_season_id uuid, p_member_id uuid, p_player_id uuid,
  p_source text, p_related_id uuid
)
RETURNS void LANGUAGE sql SET search_path = public, private AS $$
  INSERT INTO private.taxi_acquisition_context(transaction_id, league_id, league_season_id, member_id, player_id, source, related_id)
  VALUES (pg_current_xact_id(), p_league_id, p_season_id, p_member_id, p_player_id, p_source, p_related_id)
  ON CONFLICT (transaction_id, league_id, league_season_id, member_id, player_id)
  DO UPDATE SET source = EXCLUDED.source, related_id = EXCLUDED.related_id;
$$;
