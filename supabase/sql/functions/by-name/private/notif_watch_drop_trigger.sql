-- Canonical SQL source for private.notif_watch_drop_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_watch_drop_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE watcher record;
BEGIN
  FOR watcher IN SELECT w.member_id FROM public.player_watches w JOIN public.league_members m ON m.id=w.member_id AND m.league_id=w.league_id
    WHERE w.league_id=NEW.league_id AND w.player_id=NEW.player_id AND w.member_id IS DISTINCT FROM NEW.dropped_by_member_id
  LOOP
    PERFORM private.notif_enqueue('watched_player_dropped',NEW.id::text,NEW.league_id,watcher.member_id,
      jsonb_build_object('playerId',NEW.player_id,'waiverLogId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;
