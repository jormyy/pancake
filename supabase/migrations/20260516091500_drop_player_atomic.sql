-- Make the drop-player flow atomic.
--
-- Finding (iter 11, slice A):
-- - lib/roster.ts `dropPlayer` performed 3 serial writes (delete roster row,
--   insert waiver_wire_log, insert roster_transactions). If step 2 or 3 failed
--   mid-sequence the player was removed from the roster but never appeared on
--   waivers — effectively lost. This RPC wraps all three writes in a single
--   transaction so any failure rolls back the entire drop.
--
-- The function is SECURITY DEFINER but rigorously validates that the calling
-- auth.uid() owns the league_member referenced by the roster row before
-- performing any mutation. This preserves the existing RLS guarantee
-- ("roster_players_delete_own") while letting authenticated clients invoke
-- the multi-write transaction directly.

DO $migration$
BEGIN
  EXECUTE $drop_player_sql$
CREATE OR REPLACE FUNCTION public.drop_player_atomic(
  p_roster_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_clears_at timestamptz := now() + interval '48 hours';
  v_rows int;
BEGIN
  -- Lock the roster row first so concurrent drops/trades can't race.
  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Confirm the caller actually owns this league_member. This mirrors the
  -- "roster_players_delete_own" RLS policy that we bypass via SECURITY DEFINER.
  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player — you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id,
    clears_at
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id,
    v_clears_at
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
END;
$$;
$drop_player_sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.drop_player_atomic(uuid) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.drop_player_atomic(uuid) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.drop_player_atomic(uuid) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.drop_player_atomic(uuid) TO service_role';
END
$migration$;
