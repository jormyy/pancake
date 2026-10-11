BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT id, 'authenticated', 'authenticated', 'veto-read-' || n || '@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM (VALUES
    ('00000000-0000-0000-0000-000000071001'::uuid, 1),
    ('00000000-0000-0000-0000-000000071002'::uuid, 2),
    ('00000000-0000-0000-0000-000000071003'::uuid, 3),
    ('00000000-0000-0000-0000-000000071004'::uuid, 4)
  ) AS u(id, n)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
SELECT id, 'veto_read_' || right(id::text, 4), 'Veto Read ' || right(id::text, 4)
  FROM auth.users
 WHERE id::text LIKE '00000000-0000-0000-0000-00000007100%'
ON CONFLICT (id) DO NOTHING;

-- League A: users 1 and 2 trade, user 3 is a non-party member. League B: user 4 alone with user 1.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, trade_veto_mode, trade_veto_threshold_percent)
VALUES
  ('00000000-0000-0000-0000-000000071101', 'Veto Read A', 'veto-read-a', '00000000-0000-0000-0000-000000071001', 'active', 'member_vote', 100),
  ('00000000-0000-0000-0000-000000071102', 'Veto Read B', 'veto-read-b', '00000000-0000-0000-0000-000000071004', 'active', 'member_vote', 100);

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000071111', '00000000-0000-0000-0000-000000071101', 2027, true),
  ('00000000-0000-0000-0000-000000071112', '00000000-0000-0000-0000-000000071102', 2027, true);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071001', 'commissioner', 'A1'),
  ('00000000-0000-0000-0000-000000071202', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071002', 'manager', 'A2'),
  ('00000000-0000-0000-0000-000000071203', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071003', 'manager', 'A3'),
  ('00000000-0000-0000-0000-000000071204', '00000000-0000-0000-0000-000000071102', '00000000-0000-0000-0000-000000071004', 'commissioner', 'B4'),
  ('00000000-0000-0000-0000-000000071205', '00000000-0000-0000-0000-000000071102', '00000000-0000-0000-0000-000000071001', 'manager', 'B1');

-- Pending trades only; the accepted trade is promoted below through the lifecycle guard.
INSERT INTO public.trades (id, league_id, league_season_id, proposer_member_id, recipient_member_id, notes, expires_at)
VALUES
  ('00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071111',
   '00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071202', 'accepted with votes', now() + interval '7 days'),
  ('00000000-0000-0000-0000-000000071302', '00000000-0000-0000-0000-000000071101', '00000000-0000-0000-0000-000000071111',
   '00000000-0000-0000-0000-000000071201', '00000000-0000-0000-0000-000000071202', 'pending between parties', now() + interval '7 days'),
  ('00000000-0000-0000-0000-000000071303', '00000000-0000-0000-0000-000000071102', '00000000-0000-0000-0000-000000071112',
   '00000000-0000-0000-0000-000000071204', '00000000-0000-0000-0000-000000071205', 'other league', now() + interval '7 days');

INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, proposed_at)
SELECT trade_id, member_id, sort_order, sort_order = 0, now()
  FROM (VALUES
    ('00000000-0000-0000-0000-000000071301'::uuid, '00000000-0000-0000-0000-000000071201'::uuid, 0),
    ('00000000-0000-0000-0000-000000071301'::uuid, '00000000-0000-0000-0000-000000071202'::uuid, 1),
    ('00000000-0000-0000-0000-000000071302'::uuid, '00000000-0000-0000-0000-000000071201'::uuid, 0),
    ('00000000-0000-0000-0000-000000071302'::uuid, '00000000-0000-0000-0000-000000071202'::uuid, 1),
    ('00000000-0000-0000-0000-000000071303'::uuid, '00000000-0000-0000-0000-000000071204'::uuid, 0),
    ('00000000-0000-0000-0000-000000071303'::uuid, '00000000-0000-0000-0000-000000071205'::uuid, 1)
  ) AS p(trade_id, member_id, sort_order);

UPDATE public.trades SET status = 'accepted', accepted_at = now()
 WHERE id = '00000000-0000-0000-0000-000000071301';

INSERT INTO public.trade_vetos (trade_id, member_id, veto_type)
VALUES
  ('00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071203', 'member'),
  ('00000000-0000-0000-0000-000000071302', '00000000-0000-0000-0000-000000071203', 'member'),
  ('00000000-0000-0000-0000-000000071303', '00000000-0000-0000-0000-000000071204', 'member');

DO $$
DECLARE
  v_qual text;
BEGIN
  SELECT qual INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'trade_vetos' AND policyname = 'trade_vetos_select';
  IF v_qual IS DISTINCT FROM 'private.can_read_trade(trade_id)' THEN
    RAISE EXCEPTION 'trade_vetos_select must evaluate private.can_read_trade per row, found %', v_qual;
  END IF;
END $$;

SET LOCAL ROLE authenticated;

-- Each user sees exactly the vetoes of trades they can read: parties see their
-- pending trade, members see accepted trades, nobody sees another league.
DO $$
DECLARE
  v_case record;
  v_vetos uuid[];
  v_trades uuid[];
BEGIN
  FOR v_case IN
    SELECT * FROM (VALUES
      ('00000000-0000-0000-0000-000000071001'::uuid, ARRAY['00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071302', '00000000-0000-0000-0000-000000071303']::uuid[]),
      ('00000000-0000-0000-0000-000000071002'::uuid, ARRAY['00000000-0000-0000-0000-000000071301', '00000000-0000-0000-0000-000000071302']::uuid[]),
      ('00000000-0000-0000-0000-000000071003'::uuid, ARRAY['00000000-0000-0000-0000-000000071301']::uuid[]),
      ('00000000-0000-0000-0000-000000071004'::uuid, ARRAY['00000000-0000-0000-0000-000000071303']::uuid[]),
      ('00000000-0000-0000-0000-0000000719ff'::uuid, ARRAY[]::uuid[])
    ) AS c(user_id, expected)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_case.user_id, 'role', 'authenticated')::text, true);
    SELECT coalesce(array_agg(trade_id ORDER BY trade_id), ARRAY[]::uuid[]) INTO v_vetos FROM public.trade_vetos;
    SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_trades
      FROM public.trades WHERE id IN (SELECT trade_id FROM public.trade_vetos);
    IF v_vetos <> v_case.expected THEN
      RAISE EXCEPTION 'User % saw veto trades %, expected %', v_case.user_id, v_vetos, v_case.expected;
    END IF;
    IF v_vetos <> v_trades THEN
      RAISE EXCEPTION 'User % veto visibility % differs from trade visibility %', v_case.user_id, v_vetos, v_trades;
    END IF;
  END LOOP;
END $$;

RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.trade_vetos', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not read trade vetoes';
  END IF;
END $$;

ROLLBACK;
