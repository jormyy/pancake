-- Restore avatar policies removed by the production reconciliation snapshot.
DROP POLICY IF EXISTS "avatars_read_public" ON storage.objects;
CREATE POLICY "avatars_read_public" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
CREATE POLICY "avatars_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

-- A due waiver remains unavailable until the processor clears it. Waiver wins
-- use acquired_via='waiver' and are the only allowed acquisition in that window.
CREATE OR REPLACE FUNCTION private.prevent_uncleared_waiver_free_agent_add()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.acquired_via = 'free_agent'
     AND EXISTS (
       SELECT 1
         FROM public.waiver_wire_log AS waiver
        WHERE waiver.league_id = NEW.league_id
          AND waiver.league_season_id = NEW.league_season_id
          AND waiver.player_id = NEW.player_id
          AND waiver.cleared_at IS NULL
     ) THEN
    RAISE EXCEPTION 'This player is on waivers - submit a waiver claim instead.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_uncleared_waiver_free_agent_add ON public.roster_players;
CREATE TRIGGER prevent_uncleared_waiver_free_agent_add
BEFORE INSERT ON public.roster_players
FOR EACH ROW
EXECUTE FUNCTION private.prevent_uncleared_waiver_free_agent_add();

-- Deleted leagues retain rows for audit, but can never create another season.
CREATE OR REPLACE FUNCTION private.prevent_deleted_league_season_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.leagues AS league
     WHERE league.id = NEW.league_id
       AND league.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deleted leagues cannot be advanced.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_deleted_league_season_insert ON public.league_seasons;
CREATE TRIGGER prevent_deleted_league_season_insert
BEFORE INSERT ON public.league_seasons
FOR EACH ROW
EXECUTE FUNCTION private.prevent_deleted_league_season_insert();

CREATE INDEX IF NOT EXISTS idx_trades_due_accepted_queue
  ON public.trades(veto_window_expires_at, proposed_at, id)
  WHERE status = 'accepted'::public.trade_status;

DROP INDEX IF EXISTS public.idx_trade_vetos_trade_member;

RESET check_function_bodies;
