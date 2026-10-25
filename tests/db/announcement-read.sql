BEGIN;
CREATE TEMP TABLE announcement_read_fixture AS SELECT gen_random_uuid() AS league,
    gen_random_uuid() AS owner_id, gen_random_uuid() AS manager_id, gen_random_uuid() AS outsider_id,
    gen_random_uuid() AS owner_member, gen_random_uuid() AS manager_member,
    gen_random_uuid() AS newest_id, gen_random_uuid() AS oldest_id;
INSERT INTO auth.users(id, email, raw_user_meta_data)
SELECT id, id::text || '@example.test', jsonb_build_object('username', id::text)
FROM announcement_read_fixture f CROSS JOIN LATERAL unnest(ARRAY[f.owner_id, f.manager_id, f.outsider_id]) id;
INSERT INTO public.leagues(id, name, slug, commissioner_id, status)
SELECT league, 'Announcement read fixture', league::text, owner_id, 'offseason' FROM announcement_read_fixture;
INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
SELECT owner_member, league, owner_id, 'commissioner'::public.league_member_role, 'Commissioner' FROM announcement_read_fixture
UNION ALL SELECT manager_member, league, manager_id, 'manager', 'Member' FROM announcement_read_fixture;
INSERT INTO public.league_announcements(id, league_id, author_member_id, body, published_at)
SELECT oldest_id, league, owner_member, 'Older announcement', '2026-10-22T15:00:00Z'::timestamptz FROM announcement_read_fixture
UNION ALL SELECT newest_id, league, owner_member, 'Newest announcement', '2026-10-23T15:00:00Z'::timestamptz FROM announcement_read_fixture;
GRANT SELECT ON announcement_read_fixture TO authenticated;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; actual uuid[];
BEGIN
    SELECT * INTO f FROM announcement_read_fixture;
    PERFORM set_config('request.jwt.claim.sub', f.manager_id::text, true);
    SELECT array_agg(id) INTO actual FROM public.notif_list_announcements(p_league_id => f.league);
    IF actual IS DISTINCT FROM ARRAY[f.newest_id, f.oldest_id] THEN
        RAISE EXCEPTION 'Members must read announcements newest first using the client RPC argument';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', f.outsider_id::text, true);
    BEGIN
        PERFORM * FROM public.notif_list_announcements(p_league_id => f.league);
        RAISE EXCEPTION 'An outsider reads private league announcements';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
ROLLBACK;
