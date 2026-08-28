-- Season-boundary automation contracts:
-- 1. The cron idle gate must wake for offseason leagues (the whole fleet is
--    offseason every summer; the rookie-draft backstop lives on that branch).
BEGIN;

DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.invoke_season_boundary_if_due()'::regprocedure)
    INTO v_definition;
  IF v_definition !~ 'offseason' THEN
    RAISE EXCEPTION 'season-boundary idle gate does not cover offseason leagues';
  END IF;
END $$;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000097001', 'authenticated', 'authenticated',
  'boundary-gate@example.test', 'x', now(), '{}'::jsonb,
  '{"username":"boundary_gate"}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, invite_code, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000097101', 'Boundary Gate League',
  'boundary-gate-league', 'BOUNDARYGATE0000',
  '00000000-0000-0000-0000-000000097001', 'offseason'
);

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000097201', '00000000-0000-0000-0000-000000097101', 6300001, false),
  ('00000000-0000-0000-0000-000000097301', '00000000-0000-0000-0000-000000097101', 6300002, true);

ROLLBACK;
