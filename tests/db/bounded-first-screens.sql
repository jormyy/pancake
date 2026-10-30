BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE bounds_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9382);
GRANT SELECT ON bounds_fixture TO authenticated;

DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM bounds_fixture;
  INSERT INTO public.drafts(league_id, league_season_id, draft_type, status, is_mock, created_at, room_name)
    SELECT f.league_id, f.season_id, 'snake', 'completed', true, now() - g * interval '1 hour', 'done ' || g FROM generate_series(1, 30) g;
  INSERT INTO public.drafts(league_id, league_season_id, draft_type, status, is_mock, created_at, room_name)
    VALUES (f.league_id, f.season_id, 'snake', 'in_progress', true, now() - interval '1 year', 'old live room');
  INSERT INTO public.league_announcements(id, league_id, author_member_id, body, published_at)
    SELECT gen_random_uuid(), f.league_id, f.member_ids[1], 'note ' || g, now() - g * interval '1 minute' FROM generate_series(1, 8) g;
  INSERT INTO public.league_announcements(id, league_id, author_member_id, body, published_at)
    VALUES (gen_random_uuid(), f.league_id, f.member_ids[1], 'expired', now() - interval '15 days');
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; rooms jsonb; shown jsonb;
BEGIN
  SELECT * INTO f FROM bounds_fixture;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  rooms := public.view_draft_rooms(f.league_id, f.member_ids[1], '{}')->'rooms';
  PERFORM pg_temp.check_rules(jsonb_array_length(rooms) = 20, 'mock rooms load 20');
  PERFORM pg_temp.check_rules(rooms::text LIKE '%old live room%', 'an old live mock room stays in the list');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_home(f.league_id, f.member_ids[1], '{}')->'announcements') = 0, 'home omits an author''s own announcements');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[2]::text, true);
  shown := public.view_home(f.league_id, f.member_ids[2], '{}')->'announcements';
  PERFORM pg_temp.check_rules(jsonb_array_length(shown) = 5, 'home loads 5 announcements');
  PERFORM pg_temp.check_rules(shown->0->>'body' = 'note 1', 'home starts with the newest announcement');
  PERFORM pg_temp.check_rules(NOT shown::text LIKE '%expired%', 'home omits expired announcements');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
