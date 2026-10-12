-- Transactional regression: owner RLS, tuple integrity, grants and service writes.
BEGIN;
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data)
VALUES ('00000000-0000-0000-0000-000000094001', 'authenticated', 'authenticated',
  'optimizer-context@example.test', '{"username":"optimizer_context"}'),
  ('00000000-0000-0000-0000-000000094002', 'authenticated', 'authenticated',
  'optimizer-foreign@example.test', '{"username":"optimizer_foreign"}');
INSERT INTO public.leagues (id, name, slug, commissioner_id, status)
VALUES ('00000000-0000-0000-0000-000000094101', 'Context A', 'optimizer-context-a', '00000000-0000-0000-0000-000000094001', 'active'),
  ('00000000-0000-0000-0000-000000094102', 'Context B', 'optimizer-context-b', '00000000-0000-0000-0000-000000094001', 'active');
INSERT INTO public.league_members (id, league_id, user_id, role)
VALUES ('00000000-0000-0000-0000-000000094201', '00000000-0000-0000-0000-000000094101', '00000000-0000-0000-0000-000000094001', 'commissioner'),
  ('00000000-0000-0000-0000-000000094202', '00000000-0000-0000-0000-000000094102', '00000000-0000-0000-0000-000000094001', 'commissioner'),
  ('00000000-0000-0000-0000-000000094203', '00000000-0000-0000-0000-000000094101', '00000000-0000-0000-0000-000000094002', 'manager');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000094301', '00000000-0000-0000-0000-000000094101', 2094, true),
  ('00000000-0000-0000-0000-000000094302', '00000000-0000-0000-0000-000000094102', 2094, true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000094001', true);
SET LOCAL ROLE authenticated;
INSERT INTO public.lineup_optimizer_settings (league_id, league_season_id, member_id, enabled, enabled_at)
VALUES ('00000000-0000-0000-0000-000000094101', '00000000-0000-0000-0000-000000094301', '00000000-0000-0000-0000-000000094201', true, now());
UPDATE public.lineup_optimizer_settings SET enabled = false, enabled_at = null
WHERE member_id = '00000000-0000-0000-0000-000000094201';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lineup_optimizer_settings WHERE member_id = '00000000-0000-0000-0000-000000094201' AND NOT enabled) THEN
    RAISE EXCEPTION 'Owner write/readback failed';
  END IF;
  BEGIN
    UPDATE public.lineup_optimizer_settings SET member_id = '00000000-0000-0000-0000-000000094202';
    RAISE EXCEPTION 'Mismatched member allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.lineup_optimizer_settings SET league_id = '00000000-0000-0000-0000-000000094102';
    RAISE EXCEPTION 'Mismatched league allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.lineup_optimizer_settings SET league_season_id = '00000000-0000-0000-0000-000000094302';
    RAISE EXCEPTION 'Mismatched season allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN
    UPDATE public.lineup_optimizer_settings SET member_id = '00000000-0000-0000-0000-000000094203';
    RAISE EXCEPTION 'Foreign owner allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.lineup_optimizer_settings SET last_optimized_at = now();
    RAISE EXCEPTION 'Owner audit write allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.lineup_optimizer_settings;
    RAISE EXCEPTION 'Owner delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$$;
RESET ROLE;
SET LOCAL ROLE service_role;
UPDATE public.lineup_optimizer_settings SET last_optimized_at = now()
WHERE member_id = '00000000-0000-0000-0000-000000094201';
DO $$
BEGIN
  BEGIN
    INSERT INTO public.lineup_optimizer_settings (league_id, league_season_id, member_id)
    VALUES ('00000000-0000-0000-0000-000000094101', '00000000-0000-0000-0000-000000094302', '00000000-0000-0000-0000-000000094201');
    RAISE EXCEPTION 'Service context corruption allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END;
$$;
RESET ROLE;
DELETE FROM public.league_members WHERE id = '00000000-0000-0000-0000-000000094201';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.lineup_optimizer_settings WHERE league_id IN ('00000000-0000-0000-0000-000000094101', '00000000-0000-0000-0000-000000094102')) THEN
    RAISE EXCEPTION 'Membership cascade failed';
  END IF;
END; $$;
ROLLBACK;
