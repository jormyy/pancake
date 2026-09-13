-- edit_waiver_claim_atomic must apply the same gates as create_waiver_claim_atomic.
-- Each handler re-raises unless the gate's own message fired, so the block's
-- 'expected ... refused' exception (also P0001) can never satisfy itself.
-- Run: psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 -f tests/db/waiver-claim-edit-gates.sql
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000060001', 'authenticated', 'authenticated', 'waiver-edit-gates@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-000000060001', 'waiver_edit_gates', 'Waiver Edit Gates')
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit)
VALUES ('00000000-0000-0000-0000-000000060101', 'Edit Gates League', 'edit-gates-league', '00000000-0000-0000-0000-000000060001', 'active', 'rolling', NULL);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES ('00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060001', 'commissioner', 'Gates');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000060301', '00000000-0000-0000-0000-000000060101', 2098, true);
INSERT INTO public.players (id, sportsdata_id, first_name, last_name, position, eligible_positions, status, nba_team)
VALUES
  ('00000000-0000-0000-0000-000000060401', 'edit-gates-claimed', 'Claimed', 'Player', 'SG', ARRAY['SG'], 'Active', 'SIM'),
  ('00000000-0000-0000-0000-000000060402', 'edit-gates-rostered', 'Rostered', 'Player', 'PG', ARRAY['PG'], 'Active', 'SIM');
INSERT INTO public.roster_players (league_id, league_season_id, member_id, player_id, acquired_via, acquisition_cost)
VALUES ('00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060301', '00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060402', 'free_agent', 0);
-- create_waiver_claim_atomic refuses without a waiver priority row for the member.
INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES ('00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060301', '00000000-0000-0000-0000-000000060201', 1);
INSERT INTO public.waiver_wire_log (league_id, league_season_id, player_id, clears_at)
VALUES ('00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060301', '00000000-0000-0000-0000-000000060401', now() + interval '1 day');

SELECT public.create_waiver_claim_atomic(
  '00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060201',
  '00000000-0000-0000-0000-000000060401', NULL, '00000000-0000-0000-0000-000000060001', 0, 1);

-- psql variables are not interpolated inside DO $$ blocks; carry the id in a setting.
SELECT set_config('test.claim_id', id::text, true) FROM public.waiver_claims
 WHERE member_id = '00000000-0000-0000-0000-000000060201' AND status = 'pending';

-- 1. A plain edit still works while every gate is satisfied.
SELECT public.edit_waiver_claim_atomic(current_setting('test.claim_id')::uuid, '00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060001', '00000000-0000-0000-0000-000000060402', 0, 2);

-- 3. Once the waiver window closes, the edit is refused like a new claim would be.
UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute'
 WHERE player_id = '00000000-0000-0000-0000-000000060401';
DO $$
BEGIN
  PERFORM public.edit_waiver_claim_atomic(current_setting('test.claim_id')::uuid, '00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060001', NULL, 0, 3);
  RAISE EXCEPTION 'expected closed-window edit to be refused';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM NOT LIKE 'This player is no longer on waivers%' THEN RAISE; END IF;
  RAISE NOTICE 'ok: closed window refused';
END $$;
UPDATE public.waiver_wire_log SET clears_at = now() + interval '1 day'
 WHERE player_id = '00000000-0000-0000-0000-000000060401';

-- 4. A league that is no longer in an eligible state refuses edits.
UPDATE public.leagues SET status = 'setup' WHERE id = '00000000-0000-0000-0000-000000060101';
DO $$
BEGIN
  PERFORM public.edit_waiver_claim_atomic(current_setting('test.claim_id')::uuid, '00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060001', NULL, 0, 4);
  RAISE EXCEPTION 'expected ineligible league edit to be refused';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM NOT LIKE 'Waiver claims require an active or playoff season%' THEN RAISE; END IF;
  RAISE NOTICE 'ok: ineligible league refused';
END $$;
UPDATE public.leagues SET status = 'active' WHERE id = '00000000-0000-0000-0000-000000060101';

-- 5. The weekly add limit gate applies on edit as on create.
-- leagues_weekly_add_limit_valid allows NULL or >= 1, so exhaust a limit of 1 with a real consumed add.
UPDATE public.leagues SET weekly_add_limit = 1 WHERE id = '00000000-0000-0000-0000-000000060101';
SELECT private.consume_weekly_add('00000000-0000-0000-0000-000000060101', '00000000-0000-0000-0000-000000060301', '00000000-0000-0000-0000-000000060201');
DO $$
BEGIN
  PERFORM public.edit_waiver_claim_atomic(current_setting('test.claim_id')::uuid, '00000000-0000-0000-0000-000000060201', '00000000-0000-0000-0000-000000060001', NULL, 0, 5);
  RAISE EXCEPTION 'expected exhausted add limit edit to be refused';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM NOT LIKE 'Weekly add limit reached%' THEN RAISE; END IF;
  RAISE NOTICE 'ok: add limit refused';
END $$;

-- The successful edit (1) is the only one that landed.
DO $$
DECLARE v_order int; v_drop uuid;
BEGIN
  SELECT claim_order, drop_player_id INTO v_order, v_drop FROM public.waiver_claims WHERE id = current_setting('test.claim_id')::uuid;
  IF v_order <> 2 OR v_drop <> '00000000-0000-0000-0000-000000060402' THEN
    RAISE EXCEPTION 'unexpected claim state after refused edits: order=% drop=%', v_order, v_drop;
  END IF;
END $$;

ROLLBACK;
