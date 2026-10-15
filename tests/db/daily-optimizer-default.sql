BEGIN;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('00000000-0000-0000-0000-000000096001', 'daily-owner@example.test', '{"username":"daily_owner"}'),
  ('00000000-0000-0000-0000-000000096002', 'daily-joiner@example.test', '{"username":"daily_joiner"}');

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000096001', true);
SET LOCAL ROLE authenticated;
SELECT public.create_league('Daily defaults', 'Daily owner')->>'id' AS league_id \gset

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings
    WHERE member_id IN (SELECT id FROM public.league_members WHERE user_id = auth.uid()) AND enabled
  ) THEN
    RAISE EXCEPTION 'League creation does not enable daily automation';
  END IF;
END;
$$;

SELECT invite_code FROM public.leagues WHERE id = :'league_id' \gset
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000096002', true);
SELECT public.join_league_by_invite_code(:'invite_code', 'Daily joiner');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings
    WHERE member_id IN (SELECT id FROM public.league_members WHERE user_id = auth.uid()) AND enabled
  ) THEN
    RAISE EXCEPTION 'Invite join does not enable daily automation';
  END IF;
END;
$$;

INSERT INTO public.lineup_optimizer_settings (league_id, league_season_id, member_id, enabled, enabled_at)
SELECT league_id, league_season_id, member_id, false, NULL
FROM public.lineup_optimizer_settings
WHERE member_id IN (SELECT id FROM public.league_members WHERE user_id = auth.uid())
ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE
SET enabled = EXCLUDED.enabled, enabled_at = EXCLUDED.enabled_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings
    WHERE member_id IN (SELECT id FROM public.league_members WHERE user_id = auth.uid())
      AND NOT enabled AND enabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Manager opt-out does not persist';
  END IF;
END;
$$;
RESET ROLE;

UPDATE public.league_seasons SET is_current = is_current WHERE league_id = :'league_id';
UPDATE public.leagues SET status = 'archived' WHERE id = :'league_id';
SELECT public.advance_season_atomic(:'league_id');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings AS settings
    JOIN public.league_members AS member ON member.id = settings.member_id
    WHERE member.user_id = '00000000-0000-0000-0000-000000096002' AND settings.enabled
  ) THEN
    RAISE EXCEPTION 'Season creation re-enables an opted-out manager';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings AS settings
    JOIN public.league_members AS member ON member.id = settings.member_id
    JOIN public.league_seasons AS season ON season.id = settings.league_season_id
    WHERE member.user_id = '00000000-0000-0000-0000-000000096001' AND season.is_current AND settings.enabled
  ) THEN
    RAISE EXCEPTION 'Season creation loses an enabled manager';
  END IF;
END;
$$;

DELETE FROM public.lineup_optimizer_settings WHERE league_id = :'league_id';
INSERT INTO public.lineup_optimizer_settings (league_id, league_season_id, member_id)
SELECT member.league_id, season.id, member.id
FROM public.league_members AS member
JOIN public.league_seasons AS season ON season.league_id = member.league_id AND season.is_current
WHERE member.league_id = :'league_id';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.lineup_optimizer_settings AS settings
    JOIN public.league_members AS member ON member.id = settings.member_id
    WHERE member.user_id IN ('00000000-0000-0000-0000-000000096001', '00000000-0000-0000-0000-000000096002')
      AND NOT settings.enabled
  ) OR (SELECT column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lineup_optimizer_settings' AND column_name = 'enabled') <> 'true'
  THEN
    RAISE EXCEPTION 'Schema default does not enable daily automation';
  END IF;
END;
$$;

ROLLBACK;
