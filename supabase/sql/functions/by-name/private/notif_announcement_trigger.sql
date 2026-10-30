-- Canonical SQL source for private.notif_announcement_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_announcement_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE m record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members WHERE id=NEW.author_member_id AND league_id=NEW.league_id AND role IN ('commissioner','co_commissioner')) THEN
    RAISE EXCEPTION 'Commissioner author required' USING ERRCODE='42501';
  END IF;
  FOR m IN SELECT id FROM public.league_members WHERE league_id=NEW.league_id AND id<>NEW.author_member_id LOOP
    PERFORM private.notif_enqueue('commissioner_announcement',NEW.id::text,NEW.league_id,m.id,
      jsonb_build_object('announcementId',NEW.id,'body',NEW.body));
  END LOOP;
  RETURN NEW;
END;
$$;
